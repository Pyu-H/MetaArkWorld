// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MetaToken —— $META 治理币
 * @notice 元界方舟的治理代币，总量恒定，永不增发。
 *
 * 获取：创世空投、土地分红、排行榜奖励
 * 用途：购买稀有地、提案投票、进入精英区
 *
 * 与 $ARK 的分工：$ARK 负责日常流转（通胀、可无限），
 * $META 代表稀缺权益（通缩、固定上限）。
 */
contract MetaToken {
    string public name = "MetaArk Governance Token";
    string public symbol = "META";
    uint8 public constant decimals = 18;

    /// @notice 硬顶，恒定不变
    uint256 public constant MAX_SUPPLY = 100_000_000e18;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice 持币人列表（用于分红快照遍历）
    address[] public holders;
    mapping(address => bool) public isHolder;

    /// @notice 治理：提案 -> 投票
    struct Proposal {
        string title;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 deadline;
        bool executed;
    }
    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    /// @notice 精英区白名单（持币门槛达标才可进入）
    uint256 public eliteThreshold = 1000e18;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 amount, string reason);
    event ProposalCreated(uint256 indexed id, string title, uint256 deadline);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event EliteThresholdUpdated(uint256 value);

    modifier onlyOwner() {
        require(msg.sender == owner, "META: not owner");
        _;
    }

    constructor(uint256 initialSupply) {
        require(initialSupply <= MAX_SUPPLY, "META: exceeds max supply");
        owner = msg.sender;
        _mint(msg.sender, initialSupply, "genesis");
    }

    // ---------------------------------------------------------------
    // ERC-20 基础
    // ---------------------------------------------------------------

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "META: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "META: transfer to zero");
        require(balanceOf[from] >= amount, "META: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        if (!isHolder[to] && to != address(0)) {
            isHolder[to] = true;
            holders.push(to);
        }
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount, string memory reason) internal {
        require(to != address(0), "META: mint to zero");
        require(totalSupply + amount <= MAX_SUPPLY, "META: exceeds max supply");
        totalSupply += amount;
        balanceOf[to] += amount;
        if (!isHolder[to]) {
            isHolder[to] = true;
            holders.push(to);
        }
        emit Transfer(address(0), to, amount);
        emit Mint(to, amount, reason);
    }

    /// @notice 仅用于创世空投与排行榜奖励，总量受 MAX_SUPPLY 硬约束
    function mint(address to, uint256 amount, string calldata reason) external onlyOwner {
        _mint(to, amount, reason);
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    // ---------------------------------------------------------------
    // 治理投票
    // ---------------------------------------------------------------

    /// @notice 创建治理提案（如：新地图开放、税率调整、活动规则）
    function createProposal(string calldata title, uint256 durationSeconds) external returns (uint256) {
        require(balanceOf[msg.sender] >= eliteThreshold, "META: below elite threshold");
        uint256 id = proposals.length;
        proposals.push(
            Proposal({
                title: title,
                forVotes: 0,
                againstVotes: 0,
                deadline: block.timestamp + durationSeconds,
                executed: false
            })
        );
        emit ProposalCreated(id, title, block.timestamp + durationSeconds);
        return id;
    }

    /// @notice 按持币量加权投票
    function vote(uint256 id, bool support) external {
        require(id < proposals.length, "META: unknown proposal");
        Proposal storage p = proposals[id];
        require(block.timestamp < p.deadline, "META: voting closed");
        require(!hasVoted[id][msg.sender], "META: already voted");

        uint256 weight = balanceOf[msg.sender];
        require(weight > 0, "META: no voting power");

        hasVoted[id][msg.sender] = true;
        if (support) p.forVotes += weight;
        else p.againstVotes += weight;

        emit Voted(id, msg.sender, support, weight);
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposal(uint256 id)
        external
        view
        returns (string memory title, uint256 forVotes, uint256 againstVotes, uint256 deadline, bool executed)
    {
        require(id < proposals.length, "META: unknown proposal");
        Proposal storage p = proposals[id];
        return (p.title, p.forVotes, p.againstVotes, p.deadline, p.executed);
    }

    /// @notice 判断某地址是否达到精英区门槛
    function isElite(address account) external view returns (bool) {
        return balanceOf[account] >= eliteThreshold;
    }

    function setEliteThreshold(uint256 value) external onlyOwner {
        eliteThreshold = value;
        emit EliteThresholdUpdated(value);
    }
}

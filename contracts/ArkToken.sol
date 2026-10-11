// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ArkToken —— $ARK 效用币
 * @notice 元界方舟的效用型代币，无限总量但严格控产出。
 *
 * 产出场景：生产经营、每日任务、地块出租、活动奖励
 * 消耗场景：建造、升级、维修、购买材料、进入副本
 * 通缩机制：建造焚烧 5%、交易税 3%、废弃建筑回收
 *
 * 关键设计：只有被授权的 Minter（生产合约 / 任务合约）能增发，
 * 且存在全局通胀率上限，防止经济失控。
 */
contract ArkToken {
    string public name = "MetaArk Utility Token";
    string public symbol = "ARK";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    uint256 public totalBurned;

    address public owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice 被授权可以增发的地址（生产合约、任务系统）
    mapping(address => bool) public minters;

    /// @notice 全局通胀上限：每年最多增发总量的一定比例（基点，300 = 3%）
    uint256 public annualInflationCapBps = 300;
    uint256 public lastInflationEpoch;
    uint256 public inflationThisEpoch;

    /// @notice 燃烧池地址（协议抽成汇聚地）
    address public burnPool;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 amount, string reason);
    event Burn(address indexed from, uint256 amount, string reason);
    event MinterUpdated(address indexed minter, bool allowed);
    event InflationCapUpdated(uint256 bps);

    modifier onlyOwner() {
        require(msg.sender == owner, "ARK: not owner");
        _;
    }

    modifier onlyMinter() {
        require(minters[msg.sender], "ARK: not minter");
        _;
    }

    constructor(uint256 initialSupply) {
        owner = msg.sender;
        burnPool = msg.sender;
        minters[msg.sender] = true;
        lastInflationEpoch = block.timestamp;
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
            require(allowed >= amount, "ARK: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ARK: transfer to zero");
        require(balanceOf[from] >= amount, "ARK: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    // ---------------------------------------------------------------
    // 增发（受通胀上限约束）
    // ---------------------------------------------------------------

    /// @notice 铸造新币。调用者必须是 Minter，且不超过当期通胀额度。
    function mint(address to, uint256 amount, string calldata reason) external onlyMinter returns (bool) {
        _rollEpoch();
        uint256 cap = (totalSupply * annualInflationCapBps) / 10000;
        require(inflationThisEpoch + amount <= cap, "ARK: inflation cap exceeded");
        inflationThisEpoch += amount;
        _mint(to, amount, reason);
        return true;
    }

    function _mint(address to, uint256 amount, string memory reason) internal {
        require(to != address(0), "ARK: mint to zero");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
        emit Mint(to, amount, reason);
    }

    function _rollEpoch() internal {
        if (block.timestamp >= lastInflationEpoch + 365 days) {
            lastInflationEpoch = block.timestamp;
            inflationThisEpoch = 0;
        }
    }

    // ---------------------------------------------------------------
    // 通缩：燃烧
    // ---------------------------------------------------------------

    /// @notice 销毁代币，永久移出流通
    function burn(uint256 amount, string calldata reason) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ARK: insufficient balance");
        unchecked {
            balanceOf[msg.sender] -= amount;
            totalSupply -= amount;
        }
        totalBurned += amount;
        emit Transfer(msg.sender, address(0), amount);
        emit Burn(msg.sender, amount, reason);
        return true;
    }

    /// @notice 从指定地址销毁（需授权），供建造/升级合约扣除焚烧份额
    function burnFrom(address from, uint256 amount, string calldata reason) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (from != msg.sender) {
            require(allowed >= amount, "ARK: insufficient allowance");
            if (allowed != type(uint256).max) {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        require(balanceOf[from] >= amount, "ARK: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
            totalSupply -= amount;
        }
        totalBurned += amount;
        emit Transfer(from, address(0), amount);
        emit Burn(from, amount, reason);
        return true;
    }

    // ---------------------------------------------------------------
    // 协议参数
    // ---------------------------------------------------------------

    function setMinter(address minter, bool allowed) external onlyOwner {
        minters[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    function setAnnualInflationCap(uint256 bps) external onlyOwner {
        require(bps <= 2000, "ARK: cap too high");
        annualInflationCapBps = bps;
        emit InflationCapUpdated(bps);
    }

    function setBurnPool(address pool) external onlyOwner {
        require(pool != address(0), "ARK: zero pool");
        burnPool = pool;
    }

    /// @notice 当前流通量（总供应已在 burn 时扣减，此处语义等同）
    function circulatingSupply() external view returns (uint256) {
        return totalSupply;
    }

    /// @notice 当期剩余可增发额度
    function remainingInflationQuota() external view returns (uint256) {
        uint256 cap = (totalSupply * annualInflationCapBps) / 10000;
        if (block.timestamp >= lastInflationEpoch + 365 days) return cap;
        return cap > inflationThisEpoch ? cap - inflationThisEpoch : 0;
    }
}

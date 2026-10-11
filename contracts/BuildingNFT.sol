// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BuildingNFT —— 元界方舟建筑与道具（ERC-1155）
 * @notice 用 ERC-1155 承载建筑与材料，同类型可批量铸造，节省 Gas。
 *
 * 建筑分类：
 *  - 功能型：工坊(WORKSHOP) / 矿场(MINE) / 商店(SHOP) / 农田(FARM) —— 有产出逻辑
 *  - 装饰型：雕像(STATUE) / 灯塔(LIGHTHOUSE) / 乐园(PARK) —— 提升人流与地价
 *  - 材料类：木材 / 矿石 / 能量核 / 设计图 —— 可交易、可合成
 *
 * 核心机制：
 *  1. 建造消耗 $ARK，其中 5% 直接焚烧（通缩）
 *  2. 升级消耗材料 + 代币，等级越高产出/人流越高
 *  3. 维护费：长期不维护会衰败，产出衰减至零
 */
interface IArk {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function burnFrom(address from, uint256 amount, string calldata reason) external returns (bool);
}

interface ILand {
    function consumeSlot(uint256 tokenId) external returns (bool);
    function adjustPopularity(uint256 tokenId, int32 delta) external returns (uint32);
    function ownerOf(uint256 tokenId) external view returns (address);
    function touchMaintenance(uint256 tokenId) external;
}

contract BuildingNFT {
    address public owner;
    address public arkToken;
    address public landNFT;
    /// @notice 被授权的游戏逻辑合约集合
    mapping(address => bool) public controllers;
    address public gameController;

    string public name = "MetaArk Building & Material";

    /// @notice 协议税率：建造焚烧 5%
    uint256 public burnRateBps = 500;
    /// @notice 建筑槽位与土地绑定的记录：tokenId => 土地上建筑类型
    mapping(uint256 => uint256[]) public landBuildings;

    // ---------------- 建筑类型定义 ----------------
    enum BuildingKind { Workshop, Mine, Shop, Farm, Statue, Lighthouse, Park, Material }

    struct BuildingType {
        string name;
        BuildingKind kind;
        uint256 buildCostARK;    // 建造消耗 $ARK
        uint256 baseYieldPerDay; // 每日基础产出（$ARK 等值，仅功能型）
        uint32 popularityGain;   // 建成时人气加成
        uint8 maxLevel;          // 最高等级
        bool isFunctional;       // 是否有产出逻辑
    }

    BuildingType[] public buildingTypes;

    /// @notice 建筑实例状态：landTokenId => buildingTypeId => level
    mapping(uint256 => mapping(uint256 => uint8)) public buildingLevel;
    /// @notice 上次维护时间
    mapping(uint256 => mapping(uint256 => uint256)) public buildingLastMaint;

    /// @notice ERC-1155 余额：account => id => amount
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public operatorApprovals;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event BuildingTypeAdded(uint256 indexed typeId, string name, uint256 buildCostARK);
    event Built(uint256 indexed landTokenId, uint256 indexed typeId, address indexed builder, uint256 level);
    event Upgraded(uint256 indexed landTokenId, uint256 indexed typeId, uint8 newLevel);
    event BurnedFromBuild(address indexed builder, uint256 amount);
    event MaterialClaimed(address indexed player, uint256 indexed typeId, uint256 amount, uint256 decayedAmount);
    event Maintained(uint256 indexed landTokenId, uint256 indexed typeId, uint256 costARK);
    event RecipeExecuted(address indexed player, uint256 indexed outputTypeId, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "BLD: not owner");
        _;
    }

    modifier onlyController() {
        require(controllers[msg.sender] || msg.sender == owner, "BLD: not controller");
        _;
    }

    constructor(address ark, address land) {
        owner = msg.sender;
        arkToken = ark;
        landNFT = land;
        _seedTypes();
    }

    /// @notice 预置建筑与材料类型
    function _seedTypes() internal {
        _addType(unicode"基础工坊", BuildingKind.Workshop, 500e18, 30e18, 20, 5, true);
        _addType(unicode"初级矿场", BuildingKind.Mine, 800e18, 55e18, 15, 5, true);
        _addType(unicode"零售商店", BuildingKind.Shop, 700e18, 45e18, 45, 5, true);
        _addType(unicode"农田", BuildingKind.Farm, 300e18, 18e18, 10, 5, true);
        _addType(unicode"英雄雕像", BuildingKind.Statue, 1200e18, 0, 80, 3, false);
        _addType(unicode"灯塔", BuildingKind.Lighthouse, 1500e18, 0, 110, 3, false);
        _addType(unicode"主题乐园", BuildingKind.Park, 3000e18, 0, 220, 3, false);
        _addType(unicode"木材", BuildingKind.Material, 0, 0, 0, 1, false);
        _addType(unicode"矿石", BuildingKind.Material, 0, 0, 0, 1, false);
        _addType(unicode"能量核", BuildingKind.Material, 0, 0, 0, 1, false);
        _addType(unicode"设计图", BuildingKind.Material, 0, 0, 0, 1, false);
    }

    function _addType(
        string memory n,
        BuildingKind k,
        uint256 cost,
        uint256 yieldPerDay,
        uint32 pop,
        uint8 maxLv,
        bool functional
    ) internal {
        uint256 id = buildingTypes.length;
        buildingTypes.push(
            BuildingType({
                name: n,
                kind: k,
                buildCostARK: cost,
                baseYieldPerDay: yieldPerDay,
                popularityGain: pop,
                maxLevel: maxLv,
                isFunctional: functional
            })
        );
        emit BuildingTypeAdded(id, n, cost);
    }

    function typeCount() external view returns (uint256) {
        return buildingTypes.length;
    }

    function getType(uint256 id)
        external
        view
        returns (string memory n, uint8 kind, uint256 cost, uint256 yieldPerDay, uint32 pop, uint8 maxLv, bool functional)
    {
        require(id < buildingTypes.length, "BLD: unknown type");
        BuildingType storage t = buildingTypes[id];
        return (t.name, uint8(t.kind), t.buildCostARK, t.baseYieldPerDay, t.popularityGain, t.maxLevel, t.isFunctional);
    }

    // ---------------------------------------------------------------
    // ERC-1155 最小实现
    // ---------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26;
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids)
        external
        view
        returns (uint256[] memory)
    {
        require(accounts.length == ids.length, "BLD: length mismatch");
        uint256[] memory out = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            out[i] = balanceOf[accounts[i]][ids[i]];
        }
        return out;
    }

    function setApprovalForAll(address operator, bool approved_) external {
        operatorApprovals[msg.sender][operator] = approved_;
        emit ApprovalForAll(msg.sender, operator, approved_);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount) external {
        require(from == msg.sender || operatorApprovals[from][msg.sender], "BLD: not authorized");
        require(balanceOf[from][id] >= amount, "BLD: insufficient balance");
        require(to != address(0), "BLD: transfer to zero");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
    }

    /// @notice 内部铸造（材料发放走这里）
    function _mint(address to, uint256 id, uint256 amount) internal {
        require(to != address(0), "BLD: mint to zero");
        balanceOf[to][id] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
    }

    // ---------------------------------------------------------------
    // 建造 / 升级
    // ---------------------------------------------------------------

    /**
     * @notice 在土地上建造建筑。
     * @dev 消耗 buildCostARK，其中 burnRateBps（5%）焚烧，其余归协议金库。
     *      通过 LandNFT.consumeSlot 占用槽位，并提升地块人气。
     */
    function build(uint256 landTokenId, uint256 typeId, address treasury)
        external
        returns (uint8 level)
    {
        require(typeId < buildingTypes.length, "BLD: unknown type");
        BuildingType storage t = buildingTypes[typeId];
        require(t.kind != BuildingKind.Material, "BLD: materials cannot be built");
        require(ILand(landNFT).ownerOf(landTokenId) == msg.sender, "BLD: not land owner");

        uint256 cost = t.buildCostARK;
        uint256 burnAmount = (cost * burnRateBps) / 10000;
        uint256 treasuryAmount = cost - burnAmount;

        // 焚烧份额：永久销毁
        IArk(arkToken).burnFrom(msg.sender, burnAmount, "build-burn");
        // 协议份额
        if (treasuryAmount > 0) {
            IArk(arkToken).transferFrom(msg.sender, treasury, treasuryAmount);
        }

        // 占用土地槽位
        ILand(landNFT).consumeSlot(landTokenId);
        // 提升人气
        if (t.popularityGain > 0) {
            ILand(landNFT).adjustPopularity(landTokenId, int32(uint32(t.popularityGain)));
        }
        ILand(landNFT).touchMaintenance(landTokenId);

        buildingLevel[landTokenId][typeId] = 1;
        buildingLastMaint[landTokenId][typeId] = block.timestamp;
        landBuildings[landTokenId].push(typeId);

        emit Built(landTokenId, typeId, msg.sender, 1);
        emit BurnedFromBuild(msg.sender, burnAmount);
        return 1;
    }

    /**
     * @notice 升级建筑：消耗 $ARK + 材料，等级越高产出越高。
     * @dev 成本随等级指数上升，产出线性上升 => 边际收益递减，抑制无脑堆级。
     */
    function upgrade(uint256 landTokenId, uint256 typeId, address treasury) external returns (uint8 newLevel) {
        require(ILand(landNFT).ownerOf(landTokenId) == msg.sender, "BLD: not land owner");
        BuildingType storage t = buildingTypes[typeId];
        uint8 cur = buildingLevel[landTokenId][typeId];
        require(cur > 0, "BLD: not built");
        require(cur < t.maxLevel, "BLD: max level reached");

        // 升级成本 = 基础造价 * (等级+1)^1.6 近似：这里用整数近似 (lv+1)*1.6
        uint256 cost = (t.buildCostARK * (uint256(cur) + 1) * 16) / 10;
        uint256 burnAmount = (cost * burnRateBps) / 10000;
        uint256 treasuryAmount = cost - burnAmount;

        IArk(arkToken).burnFrom(msg.sender, burnAmount, "upgrade-burn");
        if (treasuryAmount > 0) {
            IArk(arkToken).transferFrom(msg.sender, treasury, treasuryAmount);
        }

        // 升级额外提升人气
        ILand(landNFT).adjustPopularity(landTokenId, int32(uint32(t.popularityGain) / 2));
        ILand(landNFT).touchMaintenance(landTokenId);

        newLevel = cur + 1;
        buildingLevel[landTokenId][typeId] = newLevel;
        buildingLastMaint[landTokenId][typeId] = block.timestamp;

        emit Upgraded(landTokenId, typeId, newLevel);
        emit BurnedFromBuild(msg.sender, burnAmount);
        return newLevel;
    }

    /**
     * @notice 维护建筑，重置衰败计时。
     * @dev 防崩盘机制：建筑需持续经营，离线过久产出衰减。
     */
    function maintain(uint256 landTokenId, uint256 typeId) external {
        require(ILand(landNFT).ownerOf(landTokenId) == msg.sender, "BLD: not land owner");
        uint8 lv = buildingLevel[landTokenId][typeId];
        require(lv > 0, "BLD: not built");

        uint256 cost = 20e18 * lv;
        IArk(arkToken).transferFrom(msg.sender, address(this), cost);

        buildingLastMaint[landTokenId][typeId] = block.timestamp;
        ILand(landNFT).touchMaintenance(landTokenId);
        emit Maintained(landTokenId, typeId, cost);
    }

    /**
     * @notice 计算建筑当前有效日产出（考虑衰败）。
     * @dev 等级线性加成；超过 7 天未维护按每多 7 天衰减 25%，最低 0。
     */
    function effectiveDailyYield(uint256 landTokenId, uint256 typeId) public view returns (uint256) {
        BuildingType storage t = buildingTypes[typeId];
        if (!t.isFunctional) return 0;
        uint8 lv = buildingLevel[landTokenId][typeId];
        if (lv == 0) return 0;

        uint256 gross = t.baseYieldPerDay * (100 + (uint256(lv) - 1) * 50);
        gross = gross / 100;

        uint256 lastMaint = buildingLastMaint[landTokenId][typeId];
        uint256 idle = block.timestamp - lastMaint;
        if (idle <= 7 days) return gross;

        uint256 decaySteps = (idle - 7 days) / 7 days;
        uint256 factorBps = 10000;
        for (uint256 i = 0; i < decaySteps && factorBps > 0; i++) {
            factorBps = (factorBps * 75) / 100; // 每 7 天衰减 25%
        }
        return (gross * factorBps) / 10000;
    }

    // ---------------------------------------------------------------
    // 生产与材料合成
    // ---------------------------------------------------------------

    /// @notice 领取生产产出（材料以 ERC-1155 发放），由游戏控制器结算
    function claimProduction(address player, uint256 materialTypeId, uint256 amount) external onlyController {
        _mint(player, materialTypeId, amount);
        emit MaterialClaimed(player, materialTypeId, amount, 0);
    }

    /**
     * @notice 材料合成：木材 x3 + 矿石 x2 -> 能量核 x1
     * @dev 打通「原料 → 制造 → 零售」链条的中段
     */
    function craftEnergyCore() external returns (uint256) {
        uint256 WOOD = 7;
        uint256 ORE = 8;
        uint256 CORE = 9;
        require(balanceOf[msg.sender][WOOD] >= 3, "BLD: need 3 wood");
        require(balanceOf[msg.sender][ORE] >= 2, "BLD: need 2 ore");

        balanceOf[msg.sender][WOOD] -= 3;
        balanceOf[msg.sender][ORE] -= 2;
        _mint(msg.sender, CORE, 1);

        emit RecipeExecuted(msg.sender, CORE, 1);
        return CORE;
    }

    function setController(address c, bool allowed) external onlyOwner {
        require(c != address(0), "BLD: zero controller");
        controllers[c] = allowed;
        if (allowed) gameController = c;
    }

    function setGameController(address c) external onlyOwner {
        require(c != address(0), "BLD: zero controller");
        controllers[c] = true;
        gameController = c;
    }

    function setBurnRate(uint256 bps) external onlyOwner {
        require(bps <= 2000, "BLD: burn rate too high");
        burnRateBps = bps;
    }

    function setTreasuryOnArk(address) external pure {}
}

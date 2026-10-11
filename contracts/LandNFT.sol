// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LandNFT —— 元界方舟土地凭证（ERC-721）
 * @notice 每块土地是一个独立 NFT，携带坐标、地形、人气值、建筑槽位与租赁配置。
 *
 * 设计要点：
 *  1. 地图分三类区域：大陆 / 海域 / 空岛（LandType）
 *  2. 地形决定产出加成：平原 / 火山 / 冰川（Terrain）
 *  3. 人气值随建筑与活动浮动，直接影响周边材料价格与地价
 *  4. 可分拆租赁：主人设「日租 / 月租」，收益由租赁市场自动结算
 *  5. 新地块按玩家活跃度解锁，不无限发地（见 unlockNextTile）
 */
contract LandNFT {
    string public name = "MetaArk Land";
    string public symbol = "MALAND";

    address public owner;
    /// @notice 被授权的游戏逻辑合约集合（可多个：BuildingNFT、LandMarket、任务系统…）
    mapping(address => bool) public controllers;
    /// @notice 主控制器（用于前端快速查询）
    address public gameController;

    uint256 public totalSupply;
    uint256 public maxTiles;       // 当前已解锁的格子上限
    uint256 public hardTileCap;    // 硬上限，永不突破

    enum LandType { Mainland, Ocean, SkyIsland }
    enum Terrain { Plain, Volcano, Glacier }

    struct Land {
        uint16 x;
        uint16 y;
        LandType landType;
        Terrain terrain;
        uint32 popularity;      // 人气值，基础 100
        uint8 slots;            // 建筑槽位总数
        uint8 usedSlots;        // 已占用槽位
        uint256 dailyRentARK;   // 日租金（以 $ARK 计价，wei）
        uint256 monthlyRentARK; // 月租金
        address renter;         // 当前租客
        uint256 rentExpiry;     // 租约到期时间
        uint256 lastMaintTime;  // 上次维护时间（用于衰败判定）
        bool listed;            // 是否在市场上挂售
        uint256 salePrice;      // 挂售价（$ARK wei）
    }

    mapping(uint256 => Land) internal lands;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public approved;
    mapping(address => mapping(address => bool)) public operatorApprovals;

    /// @notice 地形产出加成（基点，10000 = 1.0x）
    function terrainYieldBps(Terrain t) public pure returns (uint256) {
        if (t == Terrain.Plain) return 10000;    // 1.00x  均衡
        if (t == Terrain.Volcano) return 12500;  // 1.25x  矿产高，农业低
        return 11500;                            // 1.15x  冰川，稀有矿
    }

    /// @notice 区域稀有度（决定铸造成本与治理权重）
    function landTypeRarityBps(LandType t) public pure returns (uint256) {
        if (t == LandType.Mainland) return 10000;  // 常见
        if (t == LandType.Ocean) return 15000;     // 较稀有
        return 25000;                               // 空岛，最稀有
    }

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event LandMinted(uint256 indexed tokenId, address indexed to, uint16 x, uint16 y, uint8 landType, uint8 terrain);
    event PopularityChanged(uint256 indexed tokenId, uint32 oldValue, uint32 newValue);
    event SlotConsumed(uint256 indexed tokenId, uint8 used, uint8 total);
    event SlotReleased(uint256 indexed tokenId, uint8 used, uint8 total);
    event RentConfigured(uint256 indexed tokenId, uint256 dailyARK, uint256 monthlyARK);
    event RenterAssigned(uint256 indexed tokenId, address indexed renter, uint256 expiry);
    event RenterCleared(uint256 indexed tokenId);
    event Listed(uint256 indexed tokenId, uint256 price);
    event Delisted(uint256 indexed tokenId);
    event TilesUnlocked(uint256 newMaxTiles);
    event ControllerUpdated(address indexed controller, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "LAND: not owner");
        _;
    }

    modifier onlyController() {
        require(controllers[msg.sender] || msg.sender == owner, "LAND: not controller");
        _;
    }

    modifier onlyTokenOwner(uint256 tokenId) {
        require(ownerOf[tokenId] == msg.sender, "LAND: not token owner");
        _;
    }

    constructor(uint256 initialTiles, uint256 hardCap) {
        require(initialTiles <= hardCap, "LAND: initial > cap");
        owner = msg.sender;
        maxTiles = initialTiles;
        hardTileCap = hardCap;
    }

    // ---------------------------------------------------------------
    // ERC-721 核心
    // ---------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = ownerOf[tokenId];
        require(msg.sender == tokenOwner || operatorApprovals[tokenOwner][msg.sender], "LAND: not authorized");
        approved[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool isApproved) external {
        operatorApprovals[msg.sender][operator] = isApproved;
        emit ApprovalForAll(msg.sender, operator, isApproved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(ownerOf[tokenId] == from, "LAND: wrong from");
        require(to != address(0), "LAND: transfer to zero");
        require(
            msg.sender == from || operatorApprovals[from][msg.sender] || approved[tokenId] == msg.sender,
            "LAND: not authorized"
        );
        // 有租客的土地不可转让，保护租客权益
        require(lands[tokenId].renter == address(0), "LAND: land is rented out");

        delete approved[tokenId];
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        // 挂牌状态在转让后失效
        lands[tokenId].listed = false;
        lands[tokenId].salePrice = 0;

        emit Transfer(from, to, tokenId);
        emit Delisted(tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    /**
     * @notice 由授权市场合约发起的转移（用于成交交割）。
     * @dev 与 transferFrom 的区别：调用者是市场合约而非持有人，
     *      因此仅校验「调用者持有该 token 的处分授权」，并强制清空挂单状态。
     */
    function marketTransfer(address from, address to, uint256 tokenId) external onlyController {
        require(ownerOf[tokenId] == from, "LAND: wrong from");
        require(to != address(0), "LAND: transfer to zero");
        require(lands[tokenId].renter == address(0), "LAND: land is rented out");

        delete approved[tokenId];
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        lands[tokenId].listed = false;
        lands[tokenId].salePrice = 0;

        emit Transfer(from, to, tokenId);
        emit Delisted(tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(ownerOf[tokenId] != address(0), "LAND: nonexistent token");
        Land storage l = lands[tokenId];
        return string(
            abi.encodePacked(
                "ipfs://metaark/land/",
                _toString(tokenId),
                "?x=", _toString(l.x),
                "&y=", _toString(l.y),
                "&type=", _toString(uint256(l.landType)),
                "&terrain=", _toString(uint256(l.terrain))
            )
        );
    }

    // ---------------------------------------------------------------
    // 铸造与解锁
    // ---------------------------------------------------------------

    /// @notice 铸造创世地块 / 新地块（由 owner 或游戏控制器调用）
    function mintLand(
        address to,
        uint16 x,
        uint16 y,
        LandType landType,
        Terrain terrain
    ) external onlyController returns (uint256) {
        require(totalSupply < maxTiles, "LAND: all tiles for now are minted");
        uint256 tokenId = totalSupply;

        uint8 baseSlots = landType == LandType.SkyIsland ? 6 : (landType == LandType.Ocean ? 3 : 5);

        Land storage l = lands[tokenId];
        l.x = x;
        l.y = y;
        l.landType = landType;
        l.terrain = terrain;
        l.popularity = 100;
        l.slots = baseSlots;
        l.usedSlots = 0;
        l.lastMaintTime = block.timestamp;

        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        totalSupply += 1;

        emit Transfer(address(0), to, tokenId);
        emit LandMinted(tokenId, to, x, y, uint8(landType), uint8(terrain));
        return tokenId;
    }

    /**
     * @notice 按玩家活跃度解锁新地块。
     * @dev 防崩盘机制之一：不无限发地。解锁量 = f(活跃玩家数)，且不超过硬上限。
     *      活跃度由游戏控制器统计后传入，链上留痕可审计。
     */
    function unlockNextTile(uint256 activePlayers) external onlyController returns (uint256) {
        require(activePlayers > 0, "LAND: no active players");
        // 每 10 名活跃玩家解锁 1 格，单次最多解锁 20 格
        uint256 unlockCount = activePlayers / 10;
        if (unlockCount == 0) unlockCount = 1;
        if (unlockCount > 20) unlockCount = 20;

        uint256 newMax = maxTiles + unlockCount;
        if (newMax > hardTileCap) newMax = hardTileCap;
        require(newMax > maxTiles, "LAND: hard cap reached");

        maxTiles = newMax;
        emit TilesUnlocked(newMax);
        return newMax;
    }

    // ---------------------------------------------------------------
    // 游戏逻辑接口（由 gameController 调用）
    // ---------------------------------------------------------------

    function consumeSlot(uint256 tokenId) external onlyController returns (bool) {
        Land storage l = lands[tokenId];
        require(l.usedSlots < l.slots, "LAND: no free slot");
        l.usedSlots += 1;
        emit SlotConsumed(tokenId, l.usedSlots, l.slots);
        return true;
    }

    function releaseSlot(uint256 tokenId) external onlyController returns (bool) {
        Land storage l = lands[tokenId];
        require(l.usedSlots > 0, "LAND: no used slot");
        l.usedSlots -= 1;
        emit SlotReleased(tokenId, l.usedSlots, l.slots);
        return true;
    }

    /// @notice 调整人气值（建造、办活动、衰败都会调用）
    function adjustPopularity(uint256 tokenId, int32 delta) external onlyController returns (uint32) {
        Land storage l = lands[tokenId];
        uint32 old = l.popularity;
        int256 next = int256(uint256(old)) + int256(delta);
        if (next < 0) next = 0;
        if (next > 1000) next = 1000; // 人气上限
        l.popularity = uint32(uint256(next));
        emit PopularityChanged(tokenId, old, l.popularity);
        return l.popularity;
    }

    /// @notice 增加建筑槽位（升级土地）
    function addSlot(uint256 tokenId, uint8 extra) external onlyController {
        Land storage l = lands[tokenId];
        require(l.slots + extra <= 12, "LAND: slot limit");
        l.slots += extra;
    }

    // ---------------------------------------------------------------
    // 租赁配置
    // ---------------------------------------------------------------

    /// @notice 地主设置租金（$ARK 计价）
    function setRent(uint256 tokenId, uint256 dailyARK, uint256 monthlyARK) external onlyTokenOwner(tokenId) {
        require(dailyARK > 0 || monthlyARK > 0, "LAND: zero rent");
        Land storage l = lands[tokenId];
        l.dailyRentARK = dailyARK;
        l.monthlyRentARK = monthlyARK;
        emit RentConfigured(tokenId, dailyARK, monthlyARK);
    }

    function assignRenter(uint256 tokenId, address renter, uint256 durationSeconds) external onlyController {
        Land storage l = lands[tokenId];
        l.renter = renter;
        l.rentExpiry = block.timestamp + durationSeconds;
        emit RenterAssigned(tokenId, renter, l.rentExpiry);
    }

    function clearRenter(uint256 tokenId) external onlyController {
        lands[tokenId].renter = address(0);
        lands[tokenId].rentExpiry = 0;
        emit RenterCleared(tokenId);
    }

    // ---------------------------------------------------------------
    // 市场挂单
    // ---------------------------------------------------------------

    function list(uint256 tokenId, uint256 price) external onlyTokenOwner(tokenId) {
        _list(tokenId, price);
    }

    /// @notice 由授权市场合约代为挂单（调用者是市场，而非地主本人）
    function listFor(uint256 tokenId, address seller, uint256 price) external onlyController {
        require(ownerOf[tokenId] == seller, "LAND: not token owner");
        _list(tokenId, price);
    }

    function _list(uint256 tokenId, uint256 price) internal {
        require(price > 0, "LAND: zero price");
        require(lands[tokenId].renter == address(0), "LAND: rented out");
        lands[tokenId].listed = true;
        lands[tokenId].salePrice = price;
        emit Listed(tokenId, price);
    }

    function delist(uint256 tokenId) external onlyTokenOwner(tokenId) {
        lands[tokenId].listed = false;
        lands[tokenId].salePrice = 0;
        emit Delisted(tokenId);
    }

    /// @notice 由授权市场合约代为撤单
    function delistFor(uint256 tokenId) external onlyController {
        lands[tokenId].listed = false;
        lands[tokenId].salePrice = 0;
        emit Delisted(tokenId);
    }

    // ---------------------------------------------------------------
    // 查询
    // ---------------------------------------------------------------

    function getLand(uint256 tokenId)
        external
        view
        returns (
            uint16 x,
            uint16 y,
            uint8 landType,
            uint8 terrain,
            uint32 popularity,
            uint8 slots,
            uint8 usedSlots,
            uint256 dailyRentARK,
            uint256 monthlyRentARK,
            address renter,
            uint256 rentExpiry,
            bool listed,
            uint256 salePrice
        )
    {
        require(ownerOf[tokenId] != address(0), "LAND: nonexistent token");
        Land storage l = lands[tokenId];
        return (
            l.x, l.y, uint8(l.landType), uint8(l.terrain), l.popularity,
            l.slots, l.usedSlots, l.dailyRentARK, l.monthlyRentARK,
            l.renter, l.rentExpiry, l.listed, l.salePrice
        );
    }

    /// @notice 是否处于出租可用状态
    function isAvailableForRent(uint256 tokenId) external view returns (bool) {
        Land storage l = lands[tokenId];
        return (l.dailyRentARK > 0 || l.monthlyRentARK > 0) && l.renter == address(0);
    }

    /// @notice 估算地块总估值（$ARK），供前端展示地价热力
    function estimateValue(uint256 tokenId) external view returns (uint256) {
        Land storage l = lands[tokenId];
        uint256 base = 100e18;
        uint256 byType = (base * landTypeRarityBps(l.landType)) / 10000;
        uint256 byPop = (byType * (100 + uint256(l.popularity))) / 200;
        uint256 bySlots = (byPop * (100 + uint256(l.usedSlots) * 20)) / 100;
        return bySlots;
    }

    // ---------------------------------------------------------------
    // 管理
    // ---------------------------------------------------------------

    /// @notice 授权 / 撤销一个游戏逻辑合约
    function setController(address c, bool allowed) external onlyOwner {
        require(c != address(0), "LAND: zero controller");
        controllers[c] = allowed;
        if (allowed) gameController = c;
        emit ControllerUpdated(c, allowed);
    }

    /// @notice 兼容旧接口：等价于 setController(c, true)
    function setGameController(address c) external onlyOwner {
        require(c != address(0), "LAND: zero controller");
        controllers[c] = true;
        gameController = c;
        emit ControllerUpdated(c, true);
    }

    function setTerrain(uint256 tokenId, Terrain t) external onlyOwner {
        lands[tokenId].terrain = t;
    }

    function touchMaintenance(uint256 tokenId) external onlyController {
        lands[tokenId].lastMaintTime = block.timestamp;
    }

    function lastMaintenanceOf(uint256 tokenId) external view returns (uint256) {
        return lands[tokenId].lastMaintTime;
    }

    // ---------------------------------------------------------------
    // 工具
    // ---------------------------------------------------------------

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LandMarket —— 土地买卖与租赁市场
 * @notice 承担元界方舟的核心交易闭环：买地 → 盖店 → 挂租 → 别人来消费 → 提现代币
 *
 * 经济规则（与白皮书一致）：
 *  - 租赁收入分配：房东 90%，协议 10%（10% 进入燃烧池）
 *  - 土地交易税：3%（买方承担），进入燃烧池
 *  - 租金按 $ARK 计价结算，支持日租 / 月租
 */
interface IArk {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ILand {
    function ownerOf(uint256 tokenId) external view returns (address);
    function assignRenter(uint256 tokenId, address renter, uint256 durationSeconds) external;
    function clearRenter(uint256 tokenId) external;
    function getLand(uint256 tokenId)
        external
        view
        returns (
            uint16, uint16, uint8, uint8, uint32, uint8, uint8,
            uint256 dailyRentARK, uint256 monthlyRentARK,
            address renter, uint256 rentExpiry, bool listed, uint256 salePrice
        );
        function delist(uint256 tokenId) external;
        function delistFor(uint256 tokenId) external;
        function list(uint256 tokenId, uint256 price) external;
        function listFor(uint256 tokenId, address seller, uint256 price) external;
        function marketTransfer(address from, address to, uint256 tokenId) external;
    }

contract LandMarket {
    address public owner;
    address public arkToken;
    address public landNFT;
    address public metaToken;
    address public burnPool;

    /// @notice 租赁分成：房东占比（基点），9000 = 90%
    uint256 public landlordShareBps = 9000;
    /// @notice 协议抽成进入燃烧池（基点），1000 = 10%
    uint256 public protocolShareBps = 1000;
    /// @notice 土地交易税（基点），300 = 3%
    uint256 public tradeTaxBps = 300;

    struct Listing {
        address seller;
        uint256 price;
        bool active;
    }

    mapping(uint256 => Listing) public listings;
    uint256 public activeListingCount;

    /// @notice 租赁订单：租客预存租金，到时结算给房东
    struct RentOrder {
        address renter;
        uint256 landTokenId;
        uint256 amount;
        uint256 startTime;
        uint256 endTime;
        bool settled;
    }
    RentOrder[] public rentOrders;

    uint256 public totalRentVolume;
    uint256 public totalProtocolFee;
    uint256 public totalTradeVolume;
    uint256 public totalTradeTax;

    event Listed(uint256 indexed landTokenId, address indexed seller, uint256 price);
    event Delisted(uint256 indexed landTokenId);
    event LandSold(uint256 indexed landTokenId, address indexed buyer, address indexed seller, uint256 price, uint256 tax);
    event RentPaid(uint256 indexed orderId, uint256 indexed landTokenId, address indexed renter, uint256 amount);
    event RentSettled(uint256 indexed orderId, address indexed landlord, uint256 landlordAmount, uint256 protocolAmount);
    event RatesUpdated(uint256 landlordShareBps, uint256 tradeTaxBps);

    modifier onlyOwner() {
        require(msg.sender == owner, "MARKET: not owner");
        _;
    }

    constructor(address ark, address land, address meta, address pool) {
        owner = msg.sender;
        arkToken = ark;
        landNFT = land;
        metaToken = meta;
        burnPool = pool;
    }

    // ---------------------------------------------------------------
    // 土地买卖
    // ---------------------------------------------------------------

    /// @notice 地主挂单出售土地
    /// @dev 依赖 LandNFT 作为挂单状态的唯一真相源，避免双写不一致
    function listLand(uint256 landTokenId, uint256 price) external {
        require(ILand(landNFT).ownerOf(landTokenId) == msg.sender, "MARKET: not owner");
        require(price > 0, "MARKET: zero price");
        require(!listings[landTokenId].active, "MARKET: already listed");

        listings[landTokenId] = Listing({seller: msg.sender, price: price, active: true});
        activeListingCount += 1;
        // 同步到 LandNFT（此时土地未出租，正是为了挂售）
        ILand(landNFT).listFor(landTokenId, msg.sender, price);
        emit Listed(landTokenId, msg.sender, price);
    }

    function delistLand(uint256 landTokenId) external {
        Listing storage l = listings[landTokenId];
        require(l.active, "MARKET: not listed");
        require(l.seller == msg.sender, "MARKET: not seller");
        l.active = false;
        activeListingCount -= 1;
        ILand(landNFT).delistFor(landTokenId);
        emit Delisted(landTokenId);
    }

    /**
     * @notice 购买土地。买方支付 price + 3% 交易税。
     * @dev 交易税直接转入燃烧池，是通缩闭环的一环。
     */
    function buyLand(uint256 landTokenId) external returns (uint256 totalPaid) {
        Listing storage l = listings[landTokenId];
        require(l.active, "MARKET: not listed");
        address seller = l.seller;
        require(seller != msg.sender, "MARKET: cannot buy own land");

        uint256 price = l.price;
        uint256 tax = (price * tradeTaxBps) / 10000;

        // 买方支付：地价给卖方，税进燃烧池
        IArk(arkToken).transferFrom(msg.sender, seller, price);
        if (tax > 0) {
            IArk(arkToken).transferFrom(msg.sender, burnPool, tax);
        }

        l.active = false;
        activeListingCount -= 1;
        totalTradeVolume += price;
        totalTradeTax += tax;

        // 转移土地所有权（走市场专用入口，调用者为本合约）
        ILand(landNFT).marketTransfer(seller, msg.sender, landTokenId);

        totalPaid = price + tax;
        emit LandSold(landTokenId, msg.sender, seller, price, tax);
        return totalPaid;
    }

    // ---------------------------------------------------------------
    // 租赁
    // ---------------------------------------------------------------

    /**
     * @notice 租客支付租金租用土地。
     * @dev 资金先托管在合约，租约到期后房东可结算提取。
     *      分配：房东 90%，协议 10%（10% 进燃烧池）。
     */
    function rentLand(uint256 landTokenId, bool monthly) external returns (uint256 orderId) {
        (
            , , , , , , ,
            uint256 dailyRent,
            uint256 monthlyRent,
            ,
            ,
            ,
        ) = ILand(landNFT).getLand(landTokenId);

        uint256 amount = monthly ? monthlyRent : dailyRent;
        require(amount > 0, "MARKET: rent not configured");
        require(ILand(landNFT).ownerOf(landTokenId) != msg.sender, "MARKET: landlord cannot rent own land");

        // 收取租金到托管
        IArk(arkToken).transferFrom(msg.sender, address(this), amount);

        uint256 duration = monthly ? 30 days : 1 days;
        orderId = rentOrders.length;
        rentOrders.push(
            RentOrder({
                renter: msg.sender,
                landTokenId: landTokenId,
                amount: amount,
                startTime: block.timestamp,
                endTime: block.timestamp + duration,
                settled: false
            })
        );

        ILand(landNFT).assignRenter(landTokenId, msg.sender, duration);
        totalRentVolume += amount;

        emit RentPaid(orderId, landTokenId, msg.sender, amount);
        return orderId;
    }

    /**
     * @notice 结算租赁订单：房东拿 90%，协议 10% 进燃烧池。
     */
    function settleRent(uint256 orderId) external returns (uint256 landlordAmount, uint256 protocolAmount) {
        require(orderId < rentOrders.length, "MARKET: unknown order");
        RentOrder storage o = rentOrders[orderId];
        require(!o.settled, "MARKET: already settled");

        address landlord = ILand(landNFT).ownerOf(o.landTokenId);

        landlordAmount = (o.amount * landlordShareBps) / 10000;
        protocolAmount = o.amount - landlordAmount;

        o.settled = true;
        ILand(landNFT).clearRenter(o.landTokenId);

        if (landlordAmount > 0) {
            IArk(arkToken).transfer(landlord, landlordAmount);
        }
        if (protocolAmount > 0) {
            IArk(arkToken).transfer(burnPool, protocolAmount);
            totalProtocolFee += protocolAmount;
        }

        emit RentSettled(orderId, landlord, landlordAmount, protocolAmount);
        return (landlordAmount, protocolAmount);
    }

    function rentOrderCount() external view returns (uint256) {
        return rentOrders.length;
    }

    /// @notice 预估租金分配，供前端展示
    function previewRentSplit(uint256 amount)
        external
        view
        returns (uint256 landlordAmount, uint256 protocolAmount)
    {
        landlordAmount = (amount * landlordShareBps) / 10000;
        protocolAmount = amount - landlordAmount;
    }

    // ---------------------------------------------------------------
    // 参数
    // ---------------------------------------------------------------

    function setRates(uint256 landlordBps, uint256 tradeTaxBps_) external onlyOwner {
        require(landlordBps <= 10000, "MARKET: bad share");
        landlordShareBps = landlordBps;
        protocolShareBps = 10000 - landlordBps;
        tradeTaxBps = tradeTaxBps_;
        emit RatesUpdated(landlordBps, tradeTaxBps_);
    }

    function setBurnPool(address pool) external onlyOwner {
        require(pool != address(0), "MARKET: zero pool");
        burnPool = pool;
    }

    /// @notice 市场累计统计，供经济看板读取
    function stats()
        external
        view
        returns (uint256 listings_, uint256 rentVolume, uint256 protocolFee, uint256 tradeVolume, uint256 tradeTax)
    {
        return (activeListingCount, totalRentVolume, totalProtocolFee, totalTradeVolume, totalTradeTax);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LibPerpetual} from "../libraries/LibPerpetual.sol";
import {LibMarket} from "../libraries/LibMarket.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/// @notice Simple oracle interface for price feeds
interface IPriceOracle {
    function latestAnswer() external view returns (int256);
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}

/// @title PerpetualMarketFacet
/// @notice Facet for perpetual futures markets
/// @dev Implements perpetual swaps with funding rates and liquidations
contract PerpetualMarketFacet is ReentrancyGuard {
    /// @notice Maximum allowed oracle staleness (1 hour)
    uint256 public constant MAX_ORACLE_STALENESS = 1 hours;
    
    event PerpetualMarketCreated(bytes32 indexed marketId, string symbol, address indexed indexOracle);
    event PositionOpened(bytes32 indexed marketId, address indexed trader, LibPerpetual.Side side, uint256 size, uint256 collateral, uint256 entryPrice);
    event PositionClosed(bytes32 indexed marketId, address indexed trader, uint256 pnl);
    event PositionLiquidated(bytes32 indexed marketId, address indexed trader, address indexed liquidator, uint256 liquidationFee);
    event FundingPaid(bytes32 indexed marketId, address indexed trader, int256 fundingPayment);
    event FundingRateUpdated(bytes32 indexed marketId, uint256 fundingRate);
    event OrderCreated(bytes32 indexed orderId, bytes32 indexed marketId, address indexed trader, LibPerpetual.Side side, uint256 size, uint256 price);
    event OrderFilled(bytes32 indexed orderId, uint256 fillPrice);
    event OrderCancelled(bytes32 indexed orderId);

    /// @notice Create a new perpetual market
    function createPerpetualMarket(
        string calldata _symbol,
        address _indexOracle,
        uint256 _maxLeverage,
        uint256 _maintenanceMarginRate,
        uint256 _initialMarginRate,
        uint256 _liquidationFee,
        uint256 _makerFee,
        uint256 _takerFee
    ) external returns (bytes32 marketId) {
        require(_indexOracle != address(0), "Invalid oracle");
        require(_maxLeverage > 0 && _maxLeverage <= 100, "Invalid leverage");
        require(_maintenanceMarginRate > 0 && _maintenanceMarginRate < _initialMarginRate, "Invalid margin rates");

        LibPerpetual.PerpetualStorage storage ps = LibPerpetual.perpetualStorage();

        // Generate unique market ID including sender and counter to prevent collisions
        marketId = keccak256(abi.encodePacked(_symbol, block.timestamp, block.number, ps.marketIds.length, msg.sender));
        
        // Verify market doesn't already exist (defensive check)
        require(ps.markets[marketId].createdAt == 0, "Market ID collision");
        
        LibPerpetual.PerpetualMarket storage market = ps.markets[marketId];

        market.id = marketId;
        market.symbol = _symbol;
        market.indexOracle = _indexOracle;
        market.fundingRate = 0;
        market.lastFundingTime = block.timestamp;
        market.maxLeverage = _maxLeverage;
        market.maintenanceMarginRate = _maintenanceMarginRate;
        market.initialMarginRate = _initialMarginRate;
        market.liquidationFee = _liquidationFee;
        market.makerFee = _makerFee;
        market.takerFee = _takerFee;
        market.active = true;
        market.createdAt = block.timestamp;

        ps.marketIds.push(marketId);

        emit PerpetualMarketCreated(marketId, _symbol, _indexOracle);
    }

    /// @notice Open or increase a position
    function openPosition(
        bytes32 _marketId,
        LibPerpetual.Side _side,
        uint256 _size,
        uint256 _collateral,
        uint256 _maxPrice // Slippage protection
    ) external nonReentrant {
        require(_size > 0, "Size must be positive");
        require(_collateral > 0, "Collateral required");

        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);
        require(market.active, "Market not active");

        // Get current mark price from oracle
        uint256 markPrice = _getMarkPrice(market.indexOracle);
        require(markPrice <= _maxPrice, "Price slippage exceeded");

        // Calculate required margin
        // Mark price is in 8 decimals (from Chainlink), collateral is in 18 decimals
        // leverage = (size * price / 1e8) / collateral
        uint256 leverage = (_size * markPrice) / (_collateral * 1e8);
        require(leverage <= market.maxLeverage, "Leverage too high");

        // requiredMargin = (size * price * initialMarginRate) / (10000 * 1e8)
        // For 1 BTC at $50k with 10% margin: (1e18 * 5e12 * 1000) / (10000 * 1e8) = 5000 ether
        uint256 requiredMargin = (_size * markPrice * market.initialMarginRate) / (10000 * 1e8);
        require(_collateral >= requiredMargin, "Insufficient collateral");

        // Deduct collateral from user balance
        LibMarket.subtractBalance(msg.sender, _collateral);

        // Update or create position
        LibPerpetual.Position storage position = LibPerpetual.getPosition(msg.sender, _marketId);

        if (position.size == 0) {
            // New position
            position.side = _side;
            position.size = _size;
            position.collateral = _collateral;
            position.entryPrice = markPrice;
            position.lastFundingIndex = 0;
        } else {
            require(position.side == _side, "Cannot mix long/short");

            // Calculate new average entry price
            uint256 totalValue = (position.size * position.entryPrice) + (_size * markPrice);
            uint256 totalSize = position.size + _size;
            position.entryPrice = totalValue / totalSize;

            position.size = totalSize;
            position.collateral += _collateral;
        }

        // Cache market.takerFee for gas optimization
        uint256 takerFee = market.takerFee;

        // Update market totals
        if (_side == LibPerpetual.Side.LONG) {
            market.totalLongShares += _size;
            market.totalLongCollateral += _collateral;
        } else {
            market.totalShortShares += _size;
            market.totalShortCollateral += _collateral;
        }

        // Collect taker fee (markPrice is in 8 decimals)
        // fee = (size * price * feeBps) / (10000 * 1e8)
        // Example: (1e18 * 50000e8 * 10) / (10000 * 1e8) = 50 ether (0.1% of $50k)
        uint256 fee = (_size * markPrice * takerFee) / (10000 * 1e8);
        if (fee > 0) {
            LibMarket.subtractBalance(msg.sender, fee);
            LibPerpetual.PerpetualStorage storage ps = LibPerpetual.perpetualStorage();
            if (ps.feeRecipient != address(0)) {
                LibMarket.addBalance(ps.feeRecipient, fee);
            }
        }

        emit PositionOpened(_marketId, msg.sender, _side, _size, _collateral, markPrice);
    }

    /// @notice Close entire position
    function closePosition(
        bytes32 _marketId,
        uint256 _minPrice // Slippage protection
    ) external nonReentrant {
        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);
        LibPerpetual.Position storage position = LibPerpetual.getPosition(msg.sender, _marketId);

        require(position.size > 0, "No position");
        uint256 _size = position.size; // Close entire position

        // Get current mark price
        uint256 markPrice = _getMarkPrice(market.indexOracle);
        require(markPrice >= _minPrice, "Price slippage exceeded");

        // Calculate PnL for the closed portion
        int256 pnl = LibPerpetual.calculateUnrealizedPnl(position, markPrice);
        int256 closedPnl = (pnl * int256(_size)) / int256(position.size);

        // Calculate collateral to return
        uint256 collateralReturned = (position.collateral * _size) / position.size;

        // Cache storage variables for gas optimization
        LibPerpetual.Side side = position.side;
        uint256 takerFee = market.takerFee;

        // Update position
        position.size -= _size;
        position.collateral -= collateralReturned;
        position.realizedPnl = uint256(int256(position.realizedPnl) + closedPnl);

        // Update market totals
        if (side == LibPerpetual.Side.LONG) {
            market.totalLongShares -= _size;
            market.totalLongCollateral -= collateralReturned;
        } else {
            market.totalShortShares -= _size;
            market.totalShortCollateral -= collateralReturned;
        }

        // Return collateral + PnL to user
        int256 totalReturn = int256(collateralReturned) + closedPnl;
        if (totalReturn > 0) {
            LibMarket.addBalance(msg.sender, uint256(totalReturn));
        }

        // Collect taker fee (markPrice is in 8 decimals)
        // fee = (size * price * feeBps) / (10000 * 1e8)
        // Example: (1e18 * 50000e8 * 10) / (10000 * 1e8) = 50 ether (0.1% of $50k)
        uint256 fee = (_size * markPrice * takerFee) / (10000 * 1e8);
        if (fee > 0) {
            LibMarket.subtractBalance(msg.sender, fee);
            LibPerpetual.PerpetualStorage storage ps = LibPerpetual.perpetualStorage();
            if (ps.feeRecipient != address(0)) {
                LibMarket.addBalance(ps.feeRecipient, fee);
            }
        }

        emit PositionClosed(_marketId, msg.sender, position.realizedPnl);
    }

    /// @notice Liquidate an underwater position
    function liquidatePosition(
        bytes32 _marketId,
        address _trader
    ) external nonReentrant {
        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);
        LibPerpetual.Position storage position = LibPerpetual.getPosition(_trader, _marketId);

        require(position.size > 0, "No position");

        uint256 markPrice = _getMarkPrice(market.indexOracle);
        require(
            LibPerpetual.shouldLiquidate(position, markPrice, market.maintenanceMarginRate),
            "Position not liquidatable"
        );

        // Cache storage variables for gas optimization
        LibPerpetual.Side side = position.side;
        uint256 size = position.size;
        uint256 collateral = position.collateral;

        // Calculate liquidation fee
        uint256 positionValue = LibPerpetual.calculatePositionValue(position, markPrice);
        uint256 liquidationFee = (positionValue * market.liquidationFee) / 10000;

        // Update market totals
        if (side == LibPerpetual.Side.LONG) {
            market.totalLongShares -= size;
            market.totalLongCollateral -= collateral;
        } else {
            market.totalShortShares -= size;
            market.totalShortCollateral -= collateral;
        }

        // Pay liquidator
        if (liquidationFee > collateral) {
            liquidationFee = collateral;
        }
        LibMarket.addBalance(msg.sender, liquidationFee);

        // Remaining collateral goes to insurance fund
        uint256 remaining = collateral - liquidationFee;
        if (remaining > 0) {
            LibPerpetual.PerpetualStorage storage ps = LibPerpetual.perpetualStorage();
            if (ps.insuranceFund != address(0)) {
                LibMarket.addBalance(ps.insuranceFund, remaining);
            }
        }

        // Clear position
        delete LibPerpetual.perpetualStorage().positions[_trader][_marketId];

        emit PositionLiquidated(_marketId, _trader, msg.sender, liquidationFee);
    }

    /// @notice Update funding rate (called periodically)
    function updateFundingRate(bytes32 _marketId) external {
        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);
        LibPerpetual.PerpetualStorage storage ps = LibPerpetual.perpetualStorage();

        require(block.timestamp >= market.lastFundingTime + ps.fundingInterval, "Too soon");

        // Calculate funding rate based on long/short imbalance
        int256 imbalance = int256(market.totalLongShares) - int256(market.totalShortShares);
        int256 totalShares = int256(market.totalLongShares + market.totalShortShares);

        if (totalShares > 0) {
            // Funding rate = |imbalance| / total * base rate (0.01% per hour)
            // Store absolute value to avoid uint256 overflow from negative values
            int256 rateInt = (imbalance * 10) / totalShares;
            // Clamp to positive value (funding rate is always positive, direction is implied by who pays)
            market.fundingRate = rateInt >= 0 ? uint256(rateInt) : uint256(-rateInt);
        } else {
            market.fundingRate = 0;
        }

        market.lastFundingTime = block.timestamp;
        emit FundingRateUpdated(_marketId, market.fundingRate);
    }

    /// @notice Get current mark price from oracle with staleness check
    /// @dev Calls oracle's latestRoundData() which returns price in 8 decimals
    /// @return price in 8 decimals (Chainlink format)
    function _getMarkPrice(address oracle) internal view returns (uint256) {
        try IPriceOracle(oracle).latestRoundData() returns (
            uint80,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80
        ) {
            require(answer > 0, "Invalid price");
            require(block.timestamp - updatedAt <= MAX_ORACLE_STALENESS, "Stale oracle data");
            return uint256(answer);
        } catch {
            // Fallback for oracles that don't support latestRoundData
            int256 price = IPriceOracle(oracle).latestAnswer();
            require(price > 0, "Invalid price");
            return uint256(price);
        }
    }

    /// @notice Get market info
    function getPerpetualMarket(bytes32 _marketId)
        external
        view
        returns (
            string memory symbol,
            address indexOracle,
            uint256 fundingRate,
            uint256 maxLeverage,
            uint256 maintenanceMarginRate,
            bool active
        )
    {
        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);
        return (
            market.symbol,
            market.indexOracle,
            market.fundingRate,
            market.maxLeverage,
            market.maintenanceMarginRate,
            market.active
        );
    }

    /// @notice Get user position
    function getPosition(address _user, bytes32 _marketId)
        external
        view
        returns (
            LibPerpetual.Side side,
            uint256 size,
            uint256 collateral,
            uint256 entryPrice,
            int256 unrealizedPnl,
            uint256 lastFundingIndex,
            uint256 realizedPnl
        )
    {
        LibPerpetual.Position storage position = LibPerpetual.getPosition(_user, _marketId);
        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);

        uint256 markPrice = _getMarkPrice(market.indexOracle);
        int256 pnl = LibPerpetual.calculateUnrealizedPnl(position, markPrice);

        return (
            position.side,
            position.size,
            position.collateral,
            position.entryPrice,
            pnl,
            position.lastFundingIndex,
            position.realizedPnl
        );
    }

    /// @notice Calculate liquidation price for a position
    function getLiquidationPrice(address _user, bytes32 _marketId)
        external
        view
        returns (uint256)
    {
        LibPerpetual.Position storage position = LibPerpetual.getPosition(_user, _marketId);
        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);

        return LibPerpetual.calculateLiquidationPrice(position, market.maintenanceMarginRate);
    }

    /// @notice Get current mark price for a market
    function getMarkPrice(bytes32 _marketId) external view returns (uint256) {
        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);
        return _getMarkPrice(market.indexOracle);
    }

    /// @notice Get current funding rate for a market
    function getFundingRate(bytes32 _marketId) external view returns (uint256) {
        LibPerpetual.PerpetualMarket storage market = LibPerpetual.getMarket(_marketId);
        return market.fundingRate;
    }
}

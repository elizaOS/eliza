// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title LibPerpetual
/// @notice Storage library for perpetual futures markets
/// @dev Uses diamond storage pattern for upgradeability
library LibPerpetual {
    bytes32 constant PERPETUAL_STORAGE_POSITION = keccak256("polyagent.perpetual.storage");

    /// @notice Market side (long or short)
    enum Side {
        LONG,
        SHORT
    }

    /// @notice Perpetual market configuration
    struct PerpetualMarket {
        bytes32 id;
        string symbol; // e.g., "BTC-PERP"
        address indexOracle; // Oracle for index price
        uint256 fundingRate; // Current funding rate (basis points per hour)
        uint256 lastFundingTime; // Last funding payment timestamp
        uint256 maxLeverage; // Maximum leverage allowed (e.g., 10 = 10x)
        uint256 maintenanceMarginRate; // Minimum margin rate (basis points)
        uint256 initialMarginRate; // Initial margin requirement (basis points)
        uint256 liquidationFee; // Fee for liquidation (basis points)
        uint256 makerFee; // Maker fee (basis points)
        uint256 takerFee; // Taker fee (basis points)
        uint256 totalLongShares; // Total long position size
        uint256 totalShortShares; // Total short position size
        uint256 totalLongCollateral; // Total collateral for longs
        uint256 totalShortCollateral; // Total collateral for shorts
        bool active; // Market active status
        uint256 createdAt;
    }

    /// @notice User position in a perpetual market
    struct Position {
        Side side; // Long or short
        uint256 size; // Position size in shares
        uint256 collateral; // Collateral amount
        uint256 entryPrice; // Average entry price
        uint256 lastFundingIndex; // Last funding index when position was updated
        uint256 unrealizedPnl; // Cached unrealized PnL
        uint256 realizedPnl; // Realized PnL from closed positions
    }

    /// @notice Order for perpetual market
    struct Order {
        bytes32 id;
        bytes32 marketId;
        address trader;
        Side side;
        uint256 size;
        uint256 price; // Limit price (0 for market order)
        uint256 collateral;
        uint256 leverage;
        uint256 createdAt;
        bool filled;
        bool cancelled;
    }

    struct PerpetualStorage {
        mapping(bytes32 => PerpetualMarket) markets;
        mapping(address => mapping(bytes32 => Position)) positions;
        mapping(bytes32 => Order) orders;
        bytes32[] marketIds;
        bytes32[] activeOrderIds;
        uint256 fundingInterval; // Funding payment interval (default: 1 hour)
        uint256 defaultMaxLeverage; // Default max leverage
        uint256 defaultMaintenanceMarginRate; // Default maintenance margin
        uint256 defaultInitialMarginRate; // Default initial margin
        address feeRecipient;
        address insuranceFund; // Insurance fund for liquidations
    }

    /// @notice Access perpetual storage using diamond storage pattern
    /// @return ps Perpetual storage struct
    function perpetualStorage() internal pure returns (PerpetualStorage storage ps) {
        bytes32 position = PERPETUAL_STORAGE_POSITION;
        assembly {
            ps.slot := position
        }
    }

    /// @notice Get perpetual market by ID
    /// @param _marketId Market identifier
    /// @return Perpetual market storage struct
    function getMarket(bytes32 _marketId) internal view returns (PerpetualMarket storage) {
        return perpetualStorage().markets[_marketId];
    }

    /// @notice Get user's position in a perpetual market
    /// @param _user User address
    /// @param _marketId Market identifier
    /// @return Position storage struct
    function getPosition(address _user, bytes32 _marketId) internal view returns (Position storage) {
        return perpetualStorage().positions[_user][_marketId];
    }

    /// @notice Get order by ID
    /// @param _orderId Order identifier
    /// @return Order storage struct
    function getOrder(bytes32 _orderId) internal view returns (Order storage) {
        return perpetualStorage().orders[_orderId];
    }

    /// @notice Calculate position value at given price
    /// @dev markPrice is in 8 decimals (Chainlink format), size is in 18 decimals
    /// Returns value in 18 decimals (ether) for comparison with collateral
    function calculatePositionValue(
        Position storage position,
        uint256 markPrice
    ) internal view returns (uint256) {
        if (position.size == 0) return 0;
        // (size * price) / 1e8 converts from (1e18 * 1e8) to 1e18
        // Example: (10e18 * 47000e8) / 1e8 = 470000e18 ($470k in ether)
        return (position.size * markPrice) / 1e8;
    }

    /// @notice Calculate unrealized PnL
    /// @dev Both markPrice and entryPrice are in 8 decimals (Chainlink format)
    /// Returns PnL in 18 decimals (ether) for comparison with collateral
    function calculateUnrealizedPnl(
        Position storage position,
        uint256 markPrice
    ) internal view returns (int256) {
        if (position.size == 0) return 0;

        uint256 currentValue = calculatePositionValue(position, markPrice);
        // entryPrice is in 8 decimals, divide by 1e8 to get value in ether
        // Example: (10e18 * 50000e8) / 1e8 = 500000e18 ($500k in ether)
        uint256 entryValue = (position.size * position.entryPrice) / 1e8;

        if (position.side == Side.LONG) {
            return int256(currentValue) - int256(entryValue);
        } else {
            return int256(entryValue) - int256(currentValue);
        }
    }

    /// @notice Calculate margin ratio
    function calculateMarginRatio(
        Position storage position,
        uint256 markPrice
    ) internal view returns (uint256) {
        if (position.size == 0) return type(uint256).max;

        int256 pnl = calculateUnrealizedPnl(position, markPrice);
        int256 equity = int256(position.collateral) + pnl;

        if (equity <= 0) return 0;

        uint256 positionValue = calculatePositionValue(position, markPrice);
        return (uint256(equity) * 10000) / positionValue;
    }

    /// @notice Check if position should be liquidated
    function shouldLiquidate(
        Position storage position,
        uint256 markPrice,
        uint256 maintenanceMarginRate
    ) internal view returns (bool) {
        if (position.size == 0) return false;

        uint256 marginRatio = calculateMarginRatio(position, markPrice);
        return marginRatio < maintenanceMarginRate;
    }

    /// @notice Calculate funding payment
    function calculateFundingPayment(
        Position storage position,
        uint256 currentFundingIndex,
        uint256 fundingRate
    ) internal view returns (int256) {
        if (position.size == 0) return 0;

        uint256 fundingDelta = currentFundingIndex - position.lastFundingIndex;
        int256 payment = int256((position.size * fundingRate * fundingDelta) / 1e18);

        // Longs pay funding when rate is positive, shorts pay when negative
        return position.side == Side.LONG ? -payment : payment;
    }

    /// @notice Calculate liquidation price
    /// @dev entryPrice is in 8 decimals (Chainlink format)
    /// Returns liquidation price in 8 decimals for comparison with markPrice
    function calculateLiquidationPrice(
        Position storage position,
        uint256 maintenanceMarginRate
    ) internal view returns (uint256) {
        if (position.size == 0) return 0;

        // entryPrice is in 8 decimals, divide by (10000 * 1e8) to get margin in ether
        // Example: (500 * 10e18 * 50000e8) / (10000 * 1e8) = 25000e18 (5% of $500k position)
        uint256 maintenanceMargin = (maintenanceMarginRate * position.size * position.entryPrice) / (10000 * 1e8);

        if (position.side == Side.LONG) {
            // For longs: liq price = entry price - (collateral - maintenance margin) / size
            // Note: buffer is in 18 decimals (ether), need to convert to 8 decimals for price
            if (position.collateral <= maintenanceMargin) return 0;
            uint256 buffer = position.collateral - maintenanceMargin;
            // Convert buffer to price units: (buffer * 1e8) / size
            // Example: (1000e18 * 1e8) / 10e18 = 10000e8 ($10k price buffer)
            uint256 priceBuffer = (buffer * 1e8) / position.size;
            return position.entryPrice > priceBuffer ? position.entryPrice - priceBuffer : 0;
        } else {
            // For shorts: liq price = entry price + (collateral - maintenance margin) / size
            if (position.collateral <= maintenanceMargin) return type(uint256).max;
            uint256 buffer = position.collateral - maintenanceMargin;
            // Convert buffer to price units: (buffer * 1e8) / size
            uint256 priceBuffer = (buffer * 1e8) / position.size;
            return position.entryPrice + priceBuffer;
        }
    }
}

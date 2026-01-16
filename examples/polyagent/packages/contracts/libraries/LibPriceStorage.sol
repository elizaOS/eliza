// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title LibPriceStorage
/// @notice Storage library for price data
/// @dev Uses diamond storage pattern for upgradeability
library LibPriceStorage {
    bytes32 constant PRICE_STORAGE_POSITION = keccak256("babylon.price.storage");

    /// @notice Packed price tick data (fits in single storage slot)
    struct PriceTick {
        uint128 price;      // Price in 8 decimals (Chainlink format)
        uint128 timestamp;  // Unix timestamp
    }

    /// @notice Market price data
    struct MarketPriceData {
        uint256 latestTick;              // Latest tick number
        PriceTick latestPrice;           // Latest price (packed)
        mapping(uint256 => PriceTick) ticks; // Historical ticks
    }

    /// @notice Price batch for Merkle tree verification (optional)
    struct PriceBatch {
        bytes32 merkleRoot;  // Merkle root of price batch
        uint256 startTick;   // First tick in batch
        uint256 endTick;     // Last tick in batch
        uint256 timestamp;   // When batch was created
    }

    struct PriceStorage {
        mapping(bytes32 => MarketPriceData) marketPrices;
        mapping(bytes32 => PriceBatch[]) priceBatches; // Optional: for verification
        mapping(bytes32 => address) authorizedUpdaters; // Market ID => updater address
        address defaultUpdater; // Default authorized updater
        uint256 globalTickCounter; // Global tick counter
    }

    function priceStorage() internal pure returns (PriceStorage storage ps) {
        bytes32 position = PRICE_STORAGE_POSITION;
        assembly {
            ps.slot := position
        }
    }

    function getMarketPriceData(bytes32 _marketId) internal view returns (MarketPriceData storage) {
        return priceStorage().marketPrices[_marketId];
    }

    function getLatestPrice(bytes32 _marketId) internal view returns (uint256 price, uint256 timestamp, uint256 tick) {
        MarketPriceData storage data = priceStorage().marketPrices[_marketId];
        return (data.latestPrice.price, data.latestPrice.timestamp, data.latestTick);
    }

    function getPriceAtTick(bytes32 _marketId, uint256 _tick) internal view returns (uint256 price, uint256 timestamp) {
        MarketPriceData storage data = priceStorage().marketPrices[_marketId];
        PriceTick storage tick = data.ticks[_tick];
        return (tick.price, tick.timestamp);
    }
}


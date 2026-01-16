// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {LibPriceStorage} from "../libraries/LibPriceStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PriceStorageFacet
/// @notice Facet for storing final prices per tick for perpetual markets
/// @dev Implements gas-efficient batch price updates
contract PriceStorageFacet is ReentrancyGuard {
    event PriceUpdated(
        bytes32 indexed marketId,
        uint256 indexed tick,
        uint256 price,
        uint256 timestamp
    );

    event PricesBatchUpdated(
        bytes32[] marketIds,
        uint256 tick,
        uint256 timestamp
    );

    event PriceBatchSubmitted(
        bytes32 indexed marketId,
        uint256 startTick,
        uint256 endTick,
        bytes32 merkleRoot
    );

    event AuthorizedUpdaterSet(
        bytes32 indexed marketId,
        address indexed updater,
        bool authorized
    );

    /// @notice Update prices for multiple markets at a single tick
    /// @param _marketIds Array of market IDs
    /// @param _tick Tick number (use global tick counter)
    /// @param _prices Array of prices (8 decimals, Chainlink format)
    function updatePrices(
        bytes32[] calldata _marketIds,
        uint256 _tick,
        uint256[] calldata _prices
    ) external nonReentrant {
        require(_marketIds.length == _prices.length, "Length mismatch");
        require(_marketIds.length > 0, "Empty array");
        require(_marketIds.length <= 100, "Too many markets"); // Gas limit protection

        LibPriceStorage.PriceStorage storage ps = LibPriceStorage.priceStorage();

        // Check authorization
        for (uint256 i = 0; i < _marketIds.length; i++) {
            bytes32 marketId = _marketIds[i];
            address authorized = ps.authorizedUpdaters[marketId];
            if (authorized == address(0)) {
                authorized = ps.defaultUpdater;
            }
            require(
                authorized == address(0) || msg.sender == authorized,
                "Not authorized"
            );
        }

        uint256 timestamp = block.timestamp;

        // Update prices
        for (uint256 i = 0; i < _marketIds.length; i++) {
            bytes32 marketId = _marketIds[i];
            uint256 price = _prices[i];

            require(price > 0, "Invalid price");

            LibPriceStorage.MarketPriceData storage data = ps.marketPrices[marketId];

            // Skip if price unchanged (gas optimization)
            if (data.latestPrice.price == uint128(price) && data.latestTick == _tick) {
                continue;
            }

            // Update latest price
            data.latestPrice = LibPriceStorage.PriceTick({
                price: uint128(price),
                timestamp: uint128(timestamp)
            });
            data.latestTick = _tick;

            // Store historical tick
            data.ticks[_tick] = LibPriceStorage.PriceTick({
                price: uint128(price),
                timestamp: uint128(timestamp)
            });

            emit PriceUpdated(marketId, _tick, price, timestamp);
        }

        emit PricesBatchUpdated(_marketIds, _tick, timestamp);
    }

    /// @notice Update single market price
    /// @param _marketId Market ID
    /// @param _tick Tick number
    /// @param _price Price (8 decimals)
    function updatePrice(
        bytes32 _marketId,
        uint256 _tick,
        uint256 _price
    ) external nonReentrant {
        require(_price > 0, "Invalid price");

        LibPriceStorage.PriceStorage storage ps = LibPriceStorage.priceStorage();

        // Check authorization
        address authorized = ps.authorizedUpdaters[_marketId];
        if (authorized == address(0)) {
            authorized = ps.defaultUpdater;
        }
        require(
            authorized == address(0) || msg.sender == authorized,
            "Not authorized"
        );

        LibPriceStorage.MarketPriceData storage data = ps.marketPrices[_marketId];
        uint256 timestamp = block.timestamp;

        // Update latest price
        data.latestPrice = LibPriceStorage.PriceTick({
            price: uint128(_price),
            timestamp: uint128(timestamp)
        });
        data.latestTick = _tick;

        // Store historical tick
        data.ticks[_tick] = LibPriceStorage.PriceTick({
            price: uint128(_price),
            timestamp: uint128(timestamp)
        });

        emit PriceUpdated(_marketId, _tick, _price, timestamp);
    }

    /// @notice Submit Merkle root for price batch verification (optional)
    /// @param _marketId Market ID
    /// @param _startTick First tick in batch
    /// @param _endTick Last tick in batch
    /// @param _merkleRoot Merkle root of price batch
    function submitPriceBatch(
        bytes32 _marketId,
        uint256 _startTick,
        uint256 _endTick,
        bytes32 _merkleRoot
    ) external {
        LibPriceStorage.PriceStorage storage ps = LibPriceStorage.priceStorage();

        // Check authorization
        address authorized = ps.authorizedUpdaters[_marketId];
        if (authorized == address(0)) {
            authorized = ps.defaultUpdater;
        }
        require(
            authorized == address(0) || msg.sender == authorized,
            "Not authorized"
        );

        require(_startTick <= _endTick, "Invalid range");
        require(_merkleRoot != bytes32(0), "Invalid root");

        ps.priceBatches[_marketId].push(LibPriceStorage.PriceBatch({
            merkleRoot: _merkleRoot,
            startTick: _startTick,
            endTick: _endTick,
            timestamp: block.timestamp
        }));

        emit PriceBatchSubmitted(_marketId, _startTick, _endTick, _merkleRoot);
    }

    /// @notice Get latest price for a market
    /// @param _marketId Market ID
    /// @return price Latest price (8 decimals)
    /// @return timestamp Latest price timestamp
    /// @return tick Latest tick number
    function getLatestPrice(bytes32 _marketId)
        external
        view
        returns (
            uint256 price,
            uint256 timestamp,
            uint256 tick
        )
    {
        return LibPriceStorage.getLatestPrice(_marketId);
    }

    /// @notice Get price at specific tick
    /// @param _marketId Market ID
    /// @param _tick Tick number
    /// @return price Price at tick (8 decimals)
    /// @return timestamp Price timestamp
    function getPriceAtTick(bytes32 _marketId, uint256 _tick)
        external
        view
        returns (
            uint256 price,
            uint256 timestamp
        )
    {
        return LibPriceStorage.getPriceAtTick(_marketId, _tick);
    }

    /// @notice Get global tick counter
    /// @return Current global tick number
    function getGlobalTickCounter() external view returns (uint256) {
        return LibPriceStorage.priceStorage().globalTickCounter;
    }

    /// @notice Increment global tick counter (called by authorized updater)
    /// @return New tick number
    function incrementTickCounter() external returns (uint256) {
        LibPriceStorage.PriceStorage storage ps = LibPriceStorage.priceStorage();
        require(
            msg.sender == ps.defaultUpdater || LibDiamond.contractOwner() == msg.sender,
            "Not authorized"
        );
        ps.globalTickCounter++;
        return ps.globalTickCounter;
    }

    /// @notice Set authorized updater for a market (owner only)
    /// @param _marketId Market ID (bytes32(0) for default)
    /// @param _updater Updater address (address(0) to remove)
    function setAuthorizedUpdater(bytes32 _marketId, address _updater) external {
        LibDiamond.enforceIsContractOwner();
        LibPriceStorage.PriceStorage storage ps = LibPriceStorage.priceStorage();

        if (_marketId == bytes32(0)) {
            ps.defaultUpdater = _updater;
        } else {
            ps.authorizedUpdaters[_marketId] = _updater;
        }

        emit AuthorizedUpdaterSet(_marketId, _updater, _updater != address(0));
    }

    /// @notice Get authorized updater for a market
    /// @param _marketId Market ID
    /// @return Updater address (or default if not set)
    function getAuthorizedUpdater(bytes32 _marketId) external view returns (address) {
        LibPriceStorage.PriceStorage storage ps = LibPriceStorage.priceStorage();
        address authorized = ps.authorizedUpdaters[_marketId];
        return authorized == address(0) ? ps.defaultUpdater : authorized;
    }
}


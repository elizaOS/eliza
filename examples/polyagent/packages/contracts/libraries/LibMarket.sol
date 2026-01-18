// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title LibMarket
/// @notice Storage library for prediction markets
/// @dev Uses diamond storage pattern for upgradeability
library LibMarket {
    bytes32 constant MARKET_STORAGE_POSITION = keccak256("polyagent.market.storage");

    struct Market {
        bytes32 id;
        string question;
        uint8 numOutcomes;
        mapping(uint8 => uint256) shares; // outcome => total shares
        mapping(uint8 => string) outcomeNames;
        uint256 liquidity; // LMSR b parameter
        uint256 createdAt;
        uint256 resolveAt;
        bool resolved;
        uint8 winningOutcome;
        address oracle;
        uint256 totalVolume;
        uint256 feeRate; // basis points (e.g., 100 = 1%)
    }

    struct Position {
        mapping(uint8 => uint256) shares; // outcome => shares owned
        uint256 totalInvested;
        bool claimed; // Prevent double-claiming winnings
    }

    struct MarketStorage {
        mapping(bytes32 => Market) markets;
        mapping(address => mapping(bytes32 => Position)) positions;
        mapping(address => uint256) balances;
        bytes32[] marketIds;
        uint256 defaultLiquidity; // Default b parameter for LMSR
        uint256 defaultFeeRate;
        address feeRecipient;
        address chainlinkOracle; // Chainlink oracle contract address
        address mockOracle; // Mock oracle contract address (for testing)
    }

    function marketStorage() internal pure returns (MarketStorage storage ms) {
        bytes32 position = MARKET_STORAGE_POSITION;
        assembly {
            ms.slot := position
        }
    }

    function getMarket(bytes32 _marketId) internal view returns (Market storage) {
        return marketStorage().markets[_marketId];
    }

    function getPosition(address _user, bytes32 _marketId) internal view returns (Position storage) {
        return marketStorage().positions[_user][_marketId];
    }

    function getBalance(address _user) internal view returns (uint256) {
        return marketStorage().balances[_user];
    }

    function setBalance(address _user, uint256 _amount) internal {
        marketStorage().balances[_user] = _amount;
    }

    function addBalance(address _user, uint256 _amount) internal {
        marketStorage().balances[_user] += _amount;
    }

    function subtractBalance(address _user, uint256 _amount) internal {
        require(marketStorage().balances[_user] >= _amount, "Insufficient balance");
        marketStorage().balances[_user] -= _amount;
    }
}

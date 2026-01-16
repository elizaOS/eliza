// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {UD60x18, ud, intoUint256, exp, ln} from "@prb/math/src/UD60x18.sol";
import {LibMarket} from "../libraries/LibMarket.sol";

/// @title PredictionMarketFacet
/// @notice Facet for prediction market operations
/// @dev Implements LMSR (Logarithmic Market Scoring Rule) pricing
contract PredictionMarketFacet is ReentrancyGuard {
    /// @notice Minimum shares to prevent dust attacks
    uint256 public constant MIN_SHARES = 0.0001 ether; // 10^14 wei minimum
    
    event MarketCreated(bytes32 indexed marketId, string question, uint8 numOutcomes, uint256 liquidity);
    event SharesPurchased(bytes32 indexed marketId, address indexed buyer, uint8 outcome, uint256 shares, uint256 cost);
    event SharesSold(bytes32 indexed marketId, address indexed seller, uint8 outcome, uint256 shares, uint256 payout);
    event MarketResolved(bytes32 indexed marketId, uint8 winningOutcome);
    event PositionClaimed(bytes32 indexed marketId, address indexed claimer, uint256 payout);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    /// @notice Create a new prediction market
    /// @param _question The market question
    /// @param _outcomeNames Array of outcome names
    /// @param _resolveAt Timestamp when market can be resolved
    /// @param _oracle Address authorized to resolve the market
    /// @return marketId The created market ID
    function createMarket(
        string calldata _question,
        string[] calldata _outcomeNames,
        uint256 _resolveAt,
        address _oracle
    ) external returns (bytes32 marketId) {
        require(_outcomeNames.length >= 2 && _outcomeNames.length <= 10, "Invalid number of outcomes");
        require(_resolveAt > block.timestamp, "Resolve time must be in future");
        require(_oracle != address(0), "Invalid oracle address");

        LibMarket.MarketStorage storage ms = LibMarket.marketStorage();

        // Generate unique market ID using question, time, block, and counter to prevent collisions
        marketId = keccak256(abi.encodePacked(_question, block.timestamp, block.number, ms.marketIds.length, msg.sender));
        
        // Verify market doesn't already exist (defensive check)
        require(ms.markets[marketId].createdAt == 0, "Market ID collision");
        
        LibMarket.Market storage market = ms.markets[marketId];

        market.id = marketId;
        market.question = _question;
        market.numOutcomes = uint8(_outcomeNames.length);
        market.liquidity = ms.defaultLiquidity > 0 ? ms.defaultLiquidity : 1000 ether;
        market.createdAt = block.timestamp;
        market.resolveAt = _resolveAt;
        market.oracle = _oracle;
        market.feeRate = ms.defaultFeeRate > 0 ? ms.defaultFeeRate : 100; // 1% default

        for (uint8 i = 0; i < _outcomeNames.length; i++) {
            market.outcomeNames[i] = _outcomeNames[i];
            market.shares[i] = 0;
        }

        ms.marketIds.push(marketId);

        emit MarketCreated(marketId, _question, market.numOutcomes, market.liquidity);
    }

    /// @notice Calculate total cost to buy shares using LMSR (base + fee)
    /// @param _marketId The market ID
    /// @param _outcome The outcome to buy
    /// @param _numShares Number of shares to buy
    /// @return cost The total cost in wei (base LMSR cost + fee)
    function calculateCost(
        bytes32 _marketId,
        uint8 _outcome,
        uint256 _numShares
    ) public view returns (uint256 cost) {
        (uint256 totalCost, ) = calculateCostWithFee(_marketId, _outcome, _numShares);
        return totalCost;
    }

    /// @notice Calculate cost and fee separately using LMSR
    /// @param _marketId The market ID
    /// @param _outcome The outcome to buy
    /// @param _numShares Number of shares to buy
    /// @return totalCost The total cost (base + fee)
    /// @return fee The fee portion
    function calculateCostWithFee(
        bytes32 _marketId,
        uint8 _outcome,
        uint256 _numShares
    ) public view returns (uint256 totalCost, uint256 fee) {
        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        require(!market.resolved, "Market already resolved");
        require(_outcome < market.numOutcomes, "Invalid outcome");

        uint256 b = market.liquidity;

        // Calculate current cost function: C = b * ln(sum(e^(q_i/b)))
        uint256 currentCost = _costFunction(market, b);

        // Calculate new cost after adding shares
        uint256 newShares = market.shares[_outcome] + _numShares;
        uint256 newCost = _costFunctionWithShares(market, b, _outcome, newShares);

        // Base cost is difference
        uint256 baseCost = newCost - currentCost;

        // Calculate fee separately
        fee = (baseCost * market.feeRate) / 10000;
        totalCost = baseCost + fee;
    }

    /// @notice Buy shares in a market
    /// @param _marketId The market ID
    /// @param _outcome The outcome to buy
    /// @param _numShares Number of shares to buy
    function buyShares(
        bytes32 _marketId,
        uint8 _outcome,
        uint256 _numShares
    ) external nonReentrant {
        require(_numShares >= MIN_SHARES, "Shares below minimum");

        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        require(!market.resolved, "Market already resolved");
        require(block.timestamp < market.resolveAt, "Market expired");
        require(_outcome < market.numOutcomes, "Invalid outcome");

        // Get cost and fee separately to ensure accurate fee distribution
        (uint256 totalCost, uint256 fee) = calculateCostWithFee(_marketId, _outcome, _numShares);

        // Check and deduct balance
        LibMarket.subtractBalance(msg.sender, totalCost);

        // Update market state (CEI pattern)
        market.shares[_outcome] += _numShares;
        market.totalVolume += totalCost;

        // Update position
        LibMarket.Position storage position = LibMarket.getPosition(msg.sender, _marketId);
        position.shares[_outcome] += _numShares;
        position.totalInvested += totalCost;

        // Distribute exact fee to recipient
        LibMarket.MarketStorage storage ms = LibMarket.marketStorage();
        if (fee > 0 && ms.feeRecipient != address(0)) {
            LibMarket.addBalance(ms.feeRecipient, fee);
        }

        emit SharesPurchased(_marketId, msg.sender, _outcome, _numShares, totalCost);
    }

    /// @notice Sell shares in a market
    /// @param _marketId The market ID
    /// @param _outcome The outcome to sell
    /// @param _numShares Number of shares to sell
    function sellShares(
        bytes32 _marketId,
        uint8 _outcome,
        uint256 _numShares
    ) external nonReentrant {
        require(_numShares >= MIN_SHARES, "Shares below minimum");

        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        require(!market.resolved, "Market already resolved");
        require(_outcome < market.numOutcomes, "Invalid outcome");

        LibMarket.Position storage position = LibMarket.getPosition(msg.sender, _marketId);
        require(position.shares[_outcome] >= _numShares, "Insufficient shares");

        // Calculate payout (negative cost)
        uint256 payout = calculateSellPayout(_marketId, _outcome, _numShares);

        // Update position
        position.shares[_outcome] -= _numShares;

        // Update market
        market.shares[_outcome] -= _numShares;

        // Add to balance
        LibMarket.addBalance(msg.sender, payout);

        emit SharesSold(_marketId, msg.sender, _outcome, _numShares, payout);
    }

    /// @notice Calculate payout for selling shares
    function calculateSellPayout(
        bytes32 _marketId,
        uint8 _outcome,
        uint256 _numShares
    ) public view returns (uint256 payout) {
        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        uint256 b = market.liquidity;

        // Current cost
        uint256 currentCost = _costFunction(market, b);

        // Cost after removing shares
        uint256 newShares = market.shares[_outcome] - _numShares;
        uint256 newCost = _costFunctionWithShares(market, b, _outcome, newShares);

        // Payout is difference (minus fee)
        payout = currentCost - newCost;
        uint256 fee = (payout * market.feeRate) / 10000;
        payout -= fee;
    }

    /// @notice Resolve a market
    /// @param _marketId The market ID
    /// @param _winningOutcome The winning outcome
    function resolveMarket(bytes32 _marketId, uint8 _winningOutcome) external {
        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        require(!market.resolved, "Already resolved");
        require(msg.sender == market.oracle, "Only oracle can resolve");
        require(block.timestamp >= market.resolveAt, "Too early to resolve");
        require(_winningOutcome < market.numOutcomes, "Invalid outcome");

        market.resolved = true;
        market.winningOutcome = _winningOutcome;

        emit MarketResolved(_marketId, _winningOutcome);
    }

    /// @notice Claim winnings after market resolution
    /// @param _marketId The market ID
    /// @dev In LMSR prediction markets, each winning share pays exactly 1 unit (standard across Augur/Gnosis/Polymarket)
    /// @dev The market "odds" are reflected in purchase price, not payout. Winning shares always pay 1:1
    function claimWinnings(bytes32 _marketId) external nonReentrant {
        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        require(market.resolved, "Market not resolved");
        require(market.winningOutcome < market.numOutcomes, "Invalid winning outcome");

        LibMarket.Position storage position = LibMarket.getPosition(msg.sender, _marketId);
        uint256 winningShares = position.shares[market.winningOutcome];
        require(winningShares > 0, "No winning shares");

        // Prevent double-claiming
        require(!position.claimed, "Already claimed");

        // Calculate payout: standard 1:1 for winning shares in prediction markets
        // Each share represents a claim on 1 unit of currency if that outcome wins
        uint256 payout = winningShares * 1 ether;

        // Mark as claimed and clear position (CEI pattern)
        position.claimed = true;
        position.shares[market.winningOutcome] = 0;

        // Add to balance
        LibMarket.addBalance(msg.sender, payout);

        emit PositionClaimed(_marketId, msg.sender, payout);
    }

    /// @notice Deposit funds
    function deposit() external payable {
        require(msg.value > 0, "Must deposit some amount");
        LibMarket.addBalance(msg.sender, msg.value);
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw funds
    /// @param _amount Amount to withdraw
    function withdraw(uint256 _amount) external nonReentrant {
        LibMarket.subtractBalance(msg.sender, _amount);
        (bool success, ) = msg.sender.call{value: _amount}("");
        require(success, "Transfer failed");
        emit Withdrawn(msg.sender, _amount);
    }

    /// @notice Get balance
    function getBalance(address _user) external view returns (uint256) {
        return LibMarket.getBalance(_user);
    }

    /// @notice Get market info
    function getMarket(bytes32 _marketId) external view returns (
        string memory question,
        uint8 numOutcomes,
        uint256 liquidity,
        bool resolved,
        uint8 winningOutcome
    ) {
        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        return (
            market.question,
            market.numOutcomes,
            market.liquidity,
            market.resolved,
            market.winningOutcome
        );
    }

    /// @notice Get market shares for outcome
    function getMarketShares(bytes32 _marketId, uint8 _outcome) external view returns (uint256) {
        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        return market.shares[_outcome];
    }

    /// @notice Get user position
    function getPosition(address _user, bytes32 _marketId, uint8 _outcome) external view returns (uint256) {
        LibMarket.Position storage position = LibMarket.getPosition(_user, _marketId);
        return position.shares[_outcome];
    }

    // Internal LMSR cost function using PRBMath for precision
    function _costFunction(LibMarket.Market storage market, uint256 b) internal view returns (uint256) {
        UD60x18 sum = ud(0);
        for (uint8 i = 0; i < market.numOutcomes; i++) {
            // Calculate shares[i] / b in UD60x18 format
            UD60x18 exponent = ud((market.shares[i] * 1e18) / b);
            sum = sum.add(exp(exponent));
        }
        // cost = b * ln(sum)
        UD60x18 lnSum = ln(sum);
        return (b * intoUint256(lnSum)) / 1e18;
    }

    function _costFunctionWithShares(
        LibMarket.Market storage market,
        uint256 b,
        uint8 outcome,
        uint256 newShares
    ) internal view returns (uint256) {
        UD60x18 sum = ud(0);
        for (uint8 i = 0; i < market.numOutcomes; i++) {
            uint256 shares = (i == outcome) ? newShares : market.shares[i];
            // Calculate shares / b in UD60x18 format
            UD60x18 exponent = ud((shares * 1e18) / b);
            sum = sum.add(exp(exponent));
        }
        // cost = b * ln(sum)
        UD60x18 lnSum = ln(sum);
        return (b * intoUint256(lnSum)) / 1e18;
    }

}

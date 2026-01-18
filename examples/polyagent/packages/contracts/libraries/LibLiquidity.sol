// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title LibLiquidity
/// @notice Storage library for liquidity pools
/// @dev Uses diamond storage pattern for upgradeability
library LibLiquidity {
    bytes32 constant LIQUIDITY_STORAGE_POSITION = keccak256("polyagent.liquidity.storage");

    /// @notice Liquidity pool for a market
    struct LiquidityPool {
        bytes32 id;
        bytes32 marketId; // Associated market
        uint256 totalLiquidity; // Total liquidity in pool
        uint256 totalShares; // Total LP token shares
        uint256 feeRate; // LP fee rate (basis points)
        uint256 utilizationRate; // Current utilization percentage
        uint256 maxUtilization; // Maximum utilization allowed
        uint256 reserveA; // Reserve for asset A (e.g., prediction outcome 0)
        uint256 reserveB; // Reserve for asset B (e.g., prediction outcome 1)
        uint256 k; // Constant product (reserveA * reserveB)
        uint256 feesCollected; // Accumulated fees
        bool active;
        uint256 createdAt;
    }

    /// @notice LP provider position
    struct LPPosition {
        uint256 shares; // LP token amount
        uint256 depositedLiquidity; // Original deposit amount
        uint256 rewardsClaimed; // Total rewards claimed
        uint256 lastDepositTime; // Time of last deposit
    }

    /// @notice Liquidity provision reward info
    struct RewardInfo {
        uint256 rewardRate; // Rewards per block
        uint256 lastRewardBlock; // Last block rewards were distributed
        uint256 accRewardPerShare; // Accumulated rewards per share
        uint256 totalRewardsDistributed; // Total rewards paid out
    }

    struct LiquidityStorage {
        mapping(bytes32 => LiquidityPool) pools;
        mapping(address => mapping(bytes32 => LPPosition)) positions;
        mapping(bytes32 => RewardInfo) rewards;
        bytes32[] poolIds;
        uint256 defaultFeeRate; // Default LP fee rate
        uint256 defaultMaxUtilization; // Default max utilization
        address feeRecipient;
        uint256 minimumLiquidity; // Minimum liquidity to prevent division issues
    }

    function liquidityStorage() internal pure returns (LiquidityStorage storage ls) {
        bytes32 position = LIQUIDITY_STORAGE_POSITION;
        assembly {
            ls.slot := position
        }
    }

    function getPool(bytes32 _poolId) internal view returns (LiquidityPool storage) {
        return liquidityStorage().pools[_poolId];
    }

    function getPosition(address _user, bytes32 _poolId) internal view returns (LPPosition storage) {
        return liquidityStorage().positions[_user][_poolId];
    }

    function getRewardInfo(bytes32 _poolId) internal view returns (RewardInfo storage) {
        return liquidityStorage().rewards[_poolId];
    }

    /// @notice Calculate LP shares to mint for deposit
    function calculateSharesForDeposit(
        LiquidityPool storage pool,
        uint256 depositAmount
    ) internal view returns (uint256) {
        if (pool.totalShares == 0) {
            // First deposit: shares = deposit amount
            return depositAmount;
        } else {
            // shares = (deposit * totalShares) / totalLiquidity
            return (depositAmount * pool.totalShares) / pool.totalLiquidity;
        }
    }

    /// @notice Calculate liquidity to return for share redemption
    function calculateLiquidityForShares(
        LiquidityPool storage pool,
        uint256 shares
    ) internal view returns (uint256) {
        require(pool.totalShares > 0, "No shares exist");
        // liquidity = (shares * totalLiquidity) / totalShares
        return (shares * pool.totalLiquidity) / pool.totalShares;
    }

    /// @notice Calculate AMM output amount (constant product formula)
    /// @dev Uses x * y = k formula
    function calculateSwapOutput(
        uint256 inputAmount,
        uint256 inputReserve,
        uint256 outputReserve,
        uint256 feeRate
    ) internal pure returns (uint256) {
        require(inputAmount > 0, "Invalid input");
        require(inputReserve > 0 && outputReserve > 0, "Invalid reserves");

        // Apply fee: input after fee = input * (10000 - feeRate) / 10000
        uint256 inputWithFee = (inputAmount * (10000 - feeRate)) / 10000;

        // Output = (inputWithFee * outputReserve) / (inputReserve + inputWithFee)
        uint256 numerator = inputWithFee * outputReserve;
        uint256 denominator = inputReserve + inputWithFee;

        return numerator / denominator;
    }

    /// @notice Calculate AMM input amount needed for desired output
    function calculateSwapInput(
        uint256 outputAmount,
        uint256 inputReserve,
        uint256 outputReserve,
        uint256 feeRate
    ) internal pure returns (uint256) {
        require(outputAmount > 0 && outputAmount < outputReserve, "Invalid output");
        require(inputReserve > 0 && outputReserve > 0, "Invalid reserves");

        // input = (inputReserve * outputAmount) / ((outputReserve - outputAmount) * (10000 - feeRate) / 10000)
        uint256 numerator = inputReserve * outputAmount * 10000;
        uint256 denominator = (outputReserve - outputAmount) * (10000 - feeRate);

        return (numerator / denominator) + 1; // Add 1 to round up
    }

    /// @notice Calculate price impact of a swap
    function calculatePriceImpact(
        uint256 inputAmount,
        uint256 inputReserve,
        uint256 outputReserve
    ) internal pure returns (uint256) {
        if (inputAmount == 0) return 0;

        // Price before = outputReserve / inputReserve
        // Price after = (outputReserve - output) / (inputReserve + input)
        // Impact = (priceAfter - priceBefore) / priceBefore

        uint256 priceBefore = (outputReserve * 1e18) / inputReserve;
        uint256 output = calculateSwapOutput(inputAmount, inputReserve, outputReserve, 0);
        uint256 priceAfter = ((outputReserve - output) * 1e18) / (inputReserve + inputAmount);

        if (priceAfter >= priceBefore) return 0;

        return ((priceBefore - priceAfter) * 10000) / priceBefore; // Return basis points
    }

    /// @notice Calculate pending rewards for LP
    function calculatePendingRewards(
        LPPosition storage position,
        RewardInfo storage rewardInfo,
        LiquidityPool storage pool
    ) internal view returns (uint256) {
        if (position.shares == 0) return 0;

        uint256 accRewardPerShare = rewardInfo.accRewardPerShare;

        // Update accumulated rewards if new blocks have passed
        if (block.number > rewardInfo.lastRewardBlock && pool.totalShares > 0) {
            uint256 blocks = block.number - rewardInfo.lastRewardBlock;
            uint256 reward = blocks * rewardInfo.rewardRate;
            accRewardPerShare += (reward * 1e18) / pool.totalShares;
        }

        // Pending = (shares * accRewardPerShare) / 1e18 - claimed
        // Guard against underflow (can happen if rewards were claimed before proper tracking)
        uint256 totalEarned = (position.shares * accRewardPerShare) / 1e18;
        if (totalEarned <= position.rewardsClaimed) {
            return 0;
        }
        return totalEarned - position.rewardsClaimed;
    }

    /// @notice Calculate utilization rate
    function calculateUtilization(
        uint256 borrowed,
        uint256 total
    ) internal pure returns (uint256) {
        if (total == 0) return 0;
        return (borrowed * 10000) / total; // Return basis points
    }

    /// @notice Calculate optimal reserves for balanced liquidity
    function calculateOptimalReserves(
        uint256 totalLiquidity,
        uint256 priceRatio
    ) internal pure returns (uint256 reserveA, uint256 reserveB) {
        // For constant product AMM: reserveA * reserveB = k
        // And: reserveB / reserveA = priceRatio
        // Solve: reserveA = sqrt(totalLiquidity / priceRatio)

        // Simplified: split 50-50 if priceRatio = 1e18
        reserveA = totalLiquidity / 2;
        reserveB = totalLiquidity / 2;

        // Adjust based on price ratio
        if (priceRatio != 1e18) {
            // More sophisticated calculation could be added
            // For now, maintain 50-50 split for simplicity
        }
    }

    /// @notice Validate reserves maintain constant product invariant
    function validateInvariant(
        uint256 reserveA,
        uint256 reserveB,
        uint256 k,
        uint256 tolerance
    ) internal pure returns (bool) {
        // Prevent division by zero
        if (k == 0) return reserveA * reserveB == 0;
        
        uint256 currentK = reserveA * reserveB;

        // Allow small tolerance for rounding errors
        if (currentK >= k) {
            return (currentK - k) * 10000 / k <= tolerance;
        } else {
            return (k - currentK) * 10000 / k <= tolerance;
        }
    }

    /// @notice Calculate impermanent loss for LP position
    function calculateImpermanentLoss(
        uint256 depositPrice,
        uint256 currentPrice,
        uint256 depositAmount
    ) internal pure returns (uint256) {
        // IL = 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
        // Where priceRatio = currentPrice / depositPrice

        if (depositPrice == 0 || currentPrice == 0) return 0;

        uint256 priceRatio = (currentPrice * 1e18) / depositPrice;

        // Simplified IL calculation (exact formula requires sqrt)
        // IL ≈ (|priceRatio - 1e18|) / (priceRatio + 1e18) for small changes

        uint256 numerator = priceRatio > 1e18
            ? priceRatio - 1e18
            : 1e18 - priceRatio;

        return (numerator * depositAmount) / (priceRatio + 1e18);
    }
}

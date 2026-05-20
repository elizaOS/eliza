// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {UD60x18, ud, intoUint256, sqrt} from "@prb/math/src/UD60x18.sol";
import {LibLiquidity} from "../libraries/LibLiquidity.sol";
import {LibMarket} from "../libraries/LibMarket.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/// @title LiquidityPoolFacet
/// @notice Facet for liquidity pool management and AMM functionality
/// @dev Implements constant product AMM with LP rewards
contract LiquidityPoolFacet is ReentrancyGuard {
    event PoolCreated(bytes32 indexed poolId, bytes32 indexed marketId, uint256 feeRate);
    event LiquidityAdded(bytes32 indexed poolId, address indexed provider, uint256 amount, uint256 shares);
    event LiquidityRemoved(bytes32 indexed poolId, address indexed provider, uint256 shares, uint256 amount);
    event Swap(bytes32 indexed poolId, address indexed trader, uint256 amountIn, uint256 amountOut, bool aToB);
    event RewardsClaimed(bytes32 indexed poolId, address indexed provider, uint256 amount);
    event FeesCollected(bytes32 indexed poolId, uint256 amount);
    event PoolStatusChanged(bytes32 indexed poolId, bool active);

    /// @notice Create a new liquidity pool
    function createLiquidityPool(
        bytes32 _marketId,
        uint256 _feeRate,
        uint256 _maxUtilization
    ) external returns (bytes32 poolId) {
        require(_feeRate <= 1000, "Fee too high"); // Max 10%
        require(_maxUtilization > 0 && _maxUtilization <= 10000, "Invalid utilization");

        LibLiquidity.LiquidityStorage storage ls = LibLiquidity.liquidityStorage();

        // Generate unique pool ID including sender and counter to prevent collisions
        poolId = keccak256(abi.encodePacked(_marketId, block.timestamp, block.number, ls.poolIds.length, msg.sender));
        
        // Verify pool doesn't already exist (defensive check)
        require(ls.pools[poolId].createdAt == 0, "Pool ID collision");
        
        LibLiquidity.LiquidityPool storage pool = ls.pools[poolId];

        pool.id = poolId;
        pool.marketId = _marketId;
        pool.totalLiquidity = 0;
        pool.totalShares = 0;
        pool.feeRate = _feeRate > 0 ? _feeRate : ls.defaultFeeRate;
        pool.utilizationRate = 0;
        pool.maxUtilization = _maxUtilization;
        pool.reserveA = 0;
        pool.reserveB = 0;
        pool.k = 0;
        pool.feesCollected = 0;
        pool.active = true;
        pool.createdAt = block.timestamp;

        ls.poolIds.push(poolId);

        emit PoolCreated(poolId, _marketId, pool.feeRate);
    }

    /// @notice Add liquidity to pool
    function addLiquidity(
        bytes32 _poolId,
        uint256 _amount
    ) external nonReentrant returns (uint256 shares) {
        require(_amount > 0, "Amount must be positive");

        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        require(pool.active, "Pool not active");

        LibLiquidity.LiquidityStorage storage ls = LibLiquidity.liquidityStorage();

        // Ensure minimum liquidity on first deposit
        if (pool.totalShares == 0) {
            require(_amount >= ls.minimumLiquidity, "Below minimum");
        }

        // Deduct from user balance
        LibMarket.subtractBalance(msg.sender, _amount);

        // Calculate shares to mint
        shares = LibLiquidity.calculateSharesForDeposit(pool, _amount);

        // Initialize or update reserves (simplified: 50-50 split)
        if (pool.reserveA == 0 && pool.reserveB == 0) {
            pool.reserveA = _amount / 2;
            pool.reserveB = _amount / 2;
            pool.k = pool.reserveA * pool.reserveB;
        } else {
            // Add proportionally to maintain price (use OLD totalLiquidity before update)
            uint256 addToA = (_amount * pool.reserveA) / pool.totalLiquidity;
            uint256 addToB = _amount - addToA;

            pool.reserveA += addToA;
            pool.reserveB += addToB;
            pool.k = pool.reserveA * pool.reserveB;
        }

        // Update pool totals AFTER calculating proportions
        pool.totalLiquidity += _amount;
        pool.totalShares += shares;

        // Update LP position
        LibLiquidity.LPPosition storage position = LibLiquidity.getPosition(msg.sender, _poolId);
        position.shares += shares;
        position.depositedLiquidity += _amount;
        position.lastDepositTime = block.timestamp;

        // Update rewards before position changes
        _updateRewards(_poolId);

        emit LiquidityAdded(_poolId, msg.sender, _amount, shares);
    }

    /// @notice Remove liquidity from pool
    function removeLiquidity(
        bytes32 _poolId,
        uint256 _shares
    ) external nonReentrant returns (uint256 amount) {
        require(_shares > 0, "Shares must be positive");

        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        LibLiquidity.LPPosition storage position = LibLiquidity.getPosition(msg.sender, _poolId);

        require(position.shares >= _shares, "Insufficient shares");

        // Calculate liquidity to return
        amount = LibLiquidity.calculateLiquidityForShares(pool, _shares);

        // Update position - calculate depositReduction BEFORE reducing shares
        uint256 originalShares = position.shares;
        uint256 depositReduction = (position.depositedLiquidity * _shares) / originalShares;
        position.shares -= _shares;
        position.depositedLiquidity -= depositReduction;

        // Update pool
        pool.totalShares -= _shares;
        pool.totalLiquidity -= amount;

        // Update reserves proportionally
        uint256 removeFromA = (pool.reserveA * _shares) / (pool.totalShares + _shares);
        uint256 removeFromB = (pool.reserveB * _shares) / (pool.totalShares + _shares);

        pool.reserveA -= removeFromA;
        pool.reserveB -= removeFromB;
        pool.k = pool.reserveA * pool.reserveB;

        // Claim pending rewards
        _claimRewards(_poolId);

        // Return liquidity to user
        LibMarket.addBalance(msg.sender, amount);

        emit LiquidityRemoved(_poolId, msg.sender, _shares, amount);
    }

    /// @notice Swap assets using AMM
    function swap(
        bytes32 _poolId,
        uint256 _amountIn,
        uint256 _minAmountOut,
        bool _aToB // true for A->B, false for B->A
    ) external nonReentrant returns (uint256 amountOut) {
        require(_amountIn > 0, "Amount must be positive");

        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        require(pool.active, "Pool not active");

        // Calculate output using constant product formula
        if (_aToB) {
            amountOut = LibLiquidity.calculateSwapOutput(
                _amountIn,
                pool.reserveA,
                pool.reserveB,
                pool.feeRate
            );
            require(amountOut >= _minAmountOut, "Slippage exceeded");

            // Deduct input from user
            LibMarket.subtractBalance(msg.sender, _amountIn);

            // Update reserves
            pool.reserveA += _amountIn;
            pool.reserveB -= amountOut;
        } else {
            amountOut = LibLiquidity.calculateSwapOutput(
                _amountIn,
                pool.reserveB,
                pool.reserveA,
                pool.feeRate
            );
            require(amountOut >= _minAmountOut, "Slippage exceeded");

            // Deduct input from user
            LibMarket.subtractBalance(msg.sender, _amountIn);

            // Update reserves
            pool.reserveB += _amountIn;
            pool.reserveA -= amountOut;
        }

        // Validate constant product invariant (with small tolerance for fees)
        require(
            LibLiquidity.validateInvariant(pool.reserveA, pool.reserveB, pool.k, 100),
            "Invariant violated"
        );

        // Collect fees
        uint256 fee = (_amountIn * pool.feeRate) / 10000;
        pool.feesCollected += fee;

        // Update rewards
        _updateRewards(_poolId);

        // Return output to user
        LibMarket.addBalance(msg.sender, amountOut);

        emit Swap(_poolId, msg.sender, _amountIn, amountOut, _aToB);
    }

    /// @notice Set pool active status (admin only)
    /// @param _poolId The pool ID
    /// @param _active Whether the pool should be active
    function setPoolActive(bytes32 _poolId, bool _active) external {
        LibDiamond.enforceIsContractOwner();

        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        require(pool.id != bytes32(0), "Pool does not exist");

        pool.active = _active;

        emit PoolStatusChanged(_poolId, _active);
    }

    /// @notice Claim LP rewards
    function claimRewards(bytes32 _poolId) external nonReentrant returns (uint256 rewards) {
        _updateRewards(_poolId);
        rewards = _claimRewards(_poolId);
    }

    /// @notice Internal function to update rewards
    function _updateRewards(bytes32 _poolId) internal {
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        LibLiquidity.RewardInfo storage rewardInfo = LibLiquidity.getRewardInfo(_poolId);

        if (block.number <= rewardInfo.lastRewardBlock) return;
        if (pool.totalShares == 0) {
            rewardInfo.lastRewardBlock = block.number;
            return;
        }

        // Calculate rewards for elapsed blocks
        uint256 blocks = block.number - rewardInfo.lastRewardBlock;
        uint256 reward = blocks * rewardInfo.rewardRate;

        // Update accumulated reward per share
        rewardInfo.accRewardPerShare += (reward * 1e18) / pool.totalShares;
        rewardInfo.lastRewardBlock = block.number;
        rewardInfo.totalRewardsDistributed += reward;
    }

    /// @notice Internal function to claim rewards
    function _claimRewards(bytes32 _poolId) internal returns (uint256 rewards) {
        LibLiquidity.LPPosition storage position = LibLiquidity.getPosition(msg.sender, _poolId);
        LibLiquidity.RewardInfo storage rewardInfo = LibLiquidity.getRewardInfo(_poolId);
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);

        rewards = LibLiquidity.calculatePendingRewards(position, rewardInfo, pool);

        if (rewards > 0) {
            position.rewardsClaimed += rewards;
            LibMarket.addBalance(msg.sender, rewards);
            emit RewardsClaimed(_poolId, msg.sender, rewards);
        }
    }

    /// @notice Get pool info
    function getPool(bytes32 _poolId)
        external
        view
        returns (
            uint256 totalLiquidity,
            uint256 totalShares,
            uint256 reserveA,
            uint256 reserveB,
            uint256 feeRate,
            bool active
        )
    {
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        return (
            pool.totalLiquidity,
            pool.totalShares,
            pool.reserveA,
            pool.reserveB,
            pool.feeRate,
            pool.active
        );
    }

    /// @notice Get LP position
    function getLPPosition(address _user, bytes32 _poolId)
        external
        view
        returns (
            uint256 shares,
            uint256 depositedLiquidity,
            uint256 pendingRewards,
            uint256 rewardsClaimed
        )
    {
        LibLiquidity.LPPosition storage position = LibLiquidity.getPosition(_user, _poolId);
        LibLiquidity.RewardInfo storage rewardInfo = LibLiquidity.getRewardInfo(_poolId);
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);

        uint256 pending = LibLiquidity.calculatePendingRewards(position, rewardInfo, pool);

        return (
            position.shares,
            position.depositedLiquidity,
            pending,
            position.rewardsClaimed
        );
    }

    /// @notice Get pool reserves
    function getReserves(bytes32 _poolId)
        external
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        return (pool.reserveA, pool.reserveB);
    }

    /// @notice Calculate swap output preview
    function getSwapOutput(
        bytes32 _poolId,
        uint256 _amountIn,
        bool _aToB
    ) external view returns (uint256 amountOut, uint256 priceImpact) {
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);

        if (_aToB) {
            amountOut = LibLiquidity.calculateSwapOutput(
                _amountIn,
                pool.reserveA,
                pool.reserveB,
                pool.feeRate
            );
            priceImpact = LibLiquidity.calculatePriceImpact(_amountIn, pool.reserveA, pool.reserveB);
        } else {
            amountOut = LibLiquidity.calculateSwapOutput(
                _amountIn,
                pool.reserveB,
                pool.reserveA,
                pool.feeRate
            );
            priceImpact = LibLiquidity.calculatePriceImpact(_amountIn, pool.reserveB, pool.reserveA);
        }
    }

    /// @notice Calculate price impact for a swap
    function getPriceImpact(
        bytes32 _poolId,
        uint256 _amountIn
    ) external view returns (uint256 priceImpact) {
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        // Assume A to B swap for price impact calculation
        return LibLiquidity.calculatePriceImpact(_amountIn, pool.reserveA, pool.reserveB);
    }

    /// @notice Get pool utilization rate
    function getUtilization(bytes32 _poolId) external view returns (uint256) {
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);
        return pool.utilizationRate;
    }

    /// @notice Calculate impermanent loss for LP position
    function getImpermanentLoss(
        address _user,
        bytes32 _poolId,
        uint256 _initialPrice,
        uint256 _currentPrice
    ) external view returns (uint256 lossPercentage) {
        LibLiquidity.LPPosition storage position = LibLiquidity.getPosition(_user, _poolId);

        if (position.shares == 0) {
            return 0;
        }

        // If price hasn't changed, no impermanent loss
        if (_initialPrice == _currentPrice) {
            return 0;
        }

        // Calculate price ratio
        uint256 priceRatio;
        if (_currentPrice > _initialPrice) {
            priceRatio = (_currentPrice * 1e18) / _initialPrice;
        } else {
            priceRatio = (_initialPrice * 1e18) / _currentPrice;
        }

        // Impermanent loss formula: 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
        // Simplified for basis points calculation
        UD60x18 ratio = ud(priceRatio);
        UD60x18 sqrtRatio = sqrt(ratio);
        UD60x18 numerator = sqrtRatio.mul(ud(2e18));
        UD60x18 denominator = ud(1e18).add(ratio);
        UD60x18 lpValue = numerator.div(denominator);

        // Calculate loss percentage in basis points
        if (lpValue.gte(ud(1e18))) {
            return 0; // No loss
        }

        UD60x18 loss = ud(1e18).sub(lpValue);
        lossPercentage = intoUint256(loss.mul(ud(10000e18))) / 1e18;
    }

    /// @notice Get pending rewards for LP position
    function getPendingRewards(
        address _user,
        bytes32 _poolId
    ) external view returns (uint256) {
        LibLiquidity.LPPosition storage position = LibLiquidity.getPosition(_user, _poolId);
        LibLiquidity.RewardInfo storage rewardInfo = LibLiquidity.getRewardInfo(_poolId);
        LibLiquidity.LiquidityPool storage pool = LibLiquidity.getPool(_poolId);

        return LibLiquidity.calculatePendingRewards(position, rewardInfo, pool);
    }
}

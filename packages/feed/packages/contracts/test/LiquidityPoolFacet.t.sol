// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/LiquidityPoolFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../libraries/LibDiamond.sol";
import "../libraries/LibLiquidity.sol";
import "../libraries/LibMarket.sol";

contract LiquidityPoolFacetTest is Test {
    Diamond diamond;
    DiamondCutFacet diamondCutFacet;
    DiamondLoupeFacet diamondLoupeFacet;
    LiquidityPoolFacet liquidityFacet;
    PredictionMarketFacet predictionFacet;

    address owner = address(this);
    address alice = address(0x1);
    address bob = address(0x2);
    address charlie = address(0x3);

    bytes32 poolId;
    bytes32 marketId = bytes32(uint256(1));

    event PoolCreated(bytes32 indexed poolId, bytes32 indexed marketId, uint256 feeRate);
    event LiquidityAdded(bytes32 indexed poolId, address indexed provider, uint256 amount, uint256 shares);
    event LiquidityRemoved(bytes32 indexed poolId, address indexed provider, uint256 shares, uint256 amount);
    event Swap(bytes32 indexed poolId, address indexed trader, uint256 amountIn, uint256 amountOut, bool aToB);
    event RewardsClaimed(bytes32 indexed poolId, address indexed provider, uint256 amount);

    function setUp() public {
        // Deploy facets
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        liquidityFacet = new LiquidityPoolFacet();
        predictionFacet = new PredictionMarketFacet();

        // Deploy diamond (initializes DiamondCutFacet only)
        diamond = new Diamond(address(diamondCutFacet), address(diamondLoupeFacet));

        // Add DiamondLoupeFacet via diamondCut (EIP-2535 pattern)
        bytes4[] memory loupeSelectors = new bytes4[](4);
        loupeSelectors[0] = DiamondLoupeFacet.facets.selector;
        loupeSelectors[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSelectors[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSelectors[3] = DiamondLoupeFacet.facetAddress.selector;

        IDiamondCut.FacetCut[] memory loupeCuts = new IDiamondCut.FacetCut[](1);
        loupeCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: loupeSelectors
        });

        IDiamondCut(address(diamond)).diamondCut(loupeCuts, address(0), "");

        // Build diamond cut for LiquidityPoolFacet
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);

        // LiquidityPoolFacet
        bytes4[] memory liquiditySelectors = new bytes4[](14);
        liquiditySelectors[0] = LiquidityPoolFacet.createLiquidityPool.selector;
        liquiditySelectors[1] = LiquidityPoolFacet.addLiquidity.selector;
        liquiditySelectors[2] = LiquidityPoolFacet.removeLiquidity.selector;
        liquiditySelectors[3] = LiquidityPoolFacet.swap.selector;
        liquiditySelectors[4] = LiquidityPoolFacet.claimRewards.selector;
        liquiditySelectors[5] = LiquidityPoolFacet.getPool.selector;
        liquiditySelectors[6] = LiquidityPoolFacet.getLPPosition.selector;
        liquiditySelectors[7] = LiquidityPoolFacet.getReserves.selector;
        liquiditySelectors[8] = LiquidityPoolFacet.getSwapOutput.selector;
        liquiditySelectors[9] = LiquidityPoolFacet.getPriceImpact.selector;
        liquiditySelectors[10] = LiquidityPoolFacet.getUtilization.selector;
        liquiditySelectors[11] = LiquidityPoolFacet.getImpermanentLoss.selector;
        liquiditySelectors[12] = LiquidityPoolFacet.getPendingRewards.selector;
        liquiditySelectors[13] = LiquidityPoolFacet.setPoolActive.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(liquidityFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: liquiditySelectors
        });

        // Add liquidity facet
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Add prediction facet for balance management
        bytes4[] memory predictionSelectors = new bytes4[](2);
        predictionSelectors[0] = PredictionMarketFacet.deposit.selector;
        predictionSelectors[1] = PredictionMarketFacet.getBalance.selector;

        IDiamondCut.FacetCut[] memory predictionCuts = new IDiamondCut.FacetCut[](1);
        predictionCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(predictionFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: predictionSelectors
        });

        IDiamondCut(address(diamond)).diamondCut(predictionCuts, address(0), "");

        // Setup users with balances
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);

        vm.prank(alice);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();

        vm.prank(bob);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();

        vm.prank(charlie);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();
    }

    function testCreateLiquidityPool() public {
        vm.expectEmit(false, true, false, true);
        emit PoolCreated(bytes32(0), marketId, 30);

        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30, // 0.3% fee
            8000 // 80% max utilization
        );

        (
            uint256 totalLiquidity,
            uint256 totalShares,
            uint256 reserveA,
            uint256 reserveB,
            uint256 feeRate,
            bool active
        ) = LiquidityPoolFacet(address(diamond)).getPool(poolId);

        assertEq(totalLiquidity, 0);
        assertEq(totalShares, 0);
        assertEq(reserveA, 0);
        assertEq(reserveB, 0);
        assertEq(feeRate, 30);
        assertTrue(active);
    }

    function testAddLiquidity() public {
        // Create pool
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        uint256 amount = 10 ether;

        vm.expectEmit(true, true, false, true);
        emit LiquidityAdded(poolId, alice, amount, amount);

        vm.prank(alice);
        uint256 shares = LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, amount);

        // First deposit: shares = amount
        assertEq(shares, amount);

        (
            uint256 totalLiquidity,
            uint256 totalShares,
            ,
            ,
            ,
        ) = LiquidityPoolFacet(address(diamond)).getPool(poolId);

        assertEq(totalLiquidity, amount);
        assertEq(totalShares, amount);

        (uint256 positionShares, uint256 depositedLiquidity, , ) =
            LiquidityPoolFacet(address(diamond)).getLPPosition(alice, poolId);

        assertEq(positionShares, shares);
        assertEq(depositedLiquidity, amount);
    }

    function testAddLiquidityMultipleProviders() public {
        // Create pool
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        // Alice adds 10 ETH
        vm.prank(alice);
        uint256 aliceShares = LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 10 ether);

        // Bob adds 5 ETH
        vm.prank(bob);
        uint256 bobShares = LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 5 ether);

        // Bob should get half the shares Alice got
        assertEq(bobShares * 2, aliceShares);

        (
            uint256 totalLiquidity,
            uint256 totalShares,
            ,
            ,
            ,
        ) = LiquidityPoolFacet(address(diamond)).getPool(poolId);

        assertEq(totalLiquidity, 15 ether);
        assertEq(totalShares, aliceShares + bobShares);
    }

    function testRemoveLiquidity() public {
        // Create pool and add liquidity
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        vm.prank(alice);
        uint256 shares = LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 10 ether);

        uint256 balanceBefore = PredictionMarketFacet(address(diamond)).getBalance(alice);

        // Remove half the liquidity
        uint256 sharesToRemove = shares / 2;

        vm.expectEmit(true, true, false, false);
        emit LiquidityRemoved(poolId, alice, sharesToRemove, 0);

        vm.prank(alice);
        uint256 amountReturned = LiquidityPoolFacet(address(diamond)).removeLiquidity(poolId, sharesToRemove);

        uint256 balanceAfter = PredictionMarketFacet(address(diamond)).getBalance(alice);

        // Should get approximately 5 ETH back
        assertApproxEqAbs(amountReturned, 5 ether, 0.01 ether);
        assertEq(balanceAfter, balanceBefore + amountReturned);

        (uint256 positionShares, , , ) =
            LiquidityPoolFacet(address(diamond)).getLPPosition(alice, poolId);

        assertEq(positionShares, shares - sharesToRemove);
    }

    function testSwap() public {
        // Create pool and add liquidity
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30, // 0.3% fee
            8000
        );

        vm.prank(alice);
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 20 ether);

        // Check initial reserves
        (uint256 reserveA, uint256 reserveB) = LiquidityPoolFacet(address(diamond)).getReserves(poolId);
        assertEq(reserveA, 10 ether); // 50% of liquidity
        assertEq(reserveB, 10 ether); // 50% of liquidity

        // Bob swaps 1 ETH of A for B
        uint256 amountIn = 1 ether;
        (uint256 expectedOut, ) = LiquidityPoolFacet(address(diamond)).getSwapOutput(poolId, amountIn, true);

        vm.expectEmit(true, true, false, true);
        emit Swap(poolId, bob, amountIn, expectedOut, true);

        vm.prank(bob);
        uint256 amountOut = LiquidityPoolFacet(address(diamond)).swap(
            poolId,
            amountIn,
            expectedOut, // No slippage tolerance
            true // A to B
        );

        assertEq(amountOut, expectedOut);

        // Check reserves updated correctly
        (uint256 newReserveA, uint256 newReserveB) = LiquidityPoolFacet(address(diamond)).getReserves(poolId);
        assertEq(newReserveA, reserveA + amountIn);
        assertLt(newReserveB, reserveB); // B decreased
    }

    function testSwapWithSlippageProtection() public {
        // Create pool and add liquidity
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        vm.prank(alice);
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 20 ether);

        uint256 amountIn = 1 ether;
        (uint256 expectedOut, ) = LiquidityPoolFacet(address(diamond)).getSwapOutput(poolId, amountIn, true);

        // Set minimum output with 1% slippage tolerance
        uint256 minAmountOut = (expectedOut * 99) / 100;

        vm.prank(bob);
        uint256 amountOut = LiquidityPoolFacet(address(diamond)).swap(
            poolId,
            amountIn,
            minAmountOut,
            true
        );

        assertGe(amountOut, minAmountOut);
    }

    function testSwapPriceImpact() public {
        // Create pool and add liquidity
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        vm.prank(alice);
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 20 ether);

        // Small swap - low price impact
        uint256 smallSwap = 0.1 ether;
        uint256 smallImpact = LiquidityPoolFacet(address(diamond)).getPriceImpact(poolId, smallSwap);

        // Large swap - higher price impact
        uint256 largeSwap = 2 ether;
        uint256 largeImpact = LiquidityPoolFacet(address(diamond)).getPriceImpact(poolId, largeSwap);

        // Larger swap should have higher price impact
        assertGt(largeImpact, smallImpact);
    }

    function testConstantProductInvariant() public {
        // Create pool and add liquidity
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        vm.prank(alice);
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 20 ether);

        (uint256 reserveA, uint256 reserveB) = LiquidityPoolFacet(address(diamond)).getReserves(poolId);
        uint256 k = reserveA * reserveB;

        // Perform swap
        vm.prank(bob);
        LiquidityPoolFacet(address(diamond)).swap(poolId, 1 ether, 0, true);

        (uint256 newReserveA, uint256 newReserveB) = LiquidityPoolFacet(address(diamond)).getReserves(poolId);
        uint256 newK = newReserveA * newReserveB;

        // K should remain approximately constant (accounting for fees)
        // With fees, k actually increases slightly
        assertGe(newK, k);
    }

    function testRewardDistribution() public {
        // Create pool with reward rate
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        // Add liquidity
        vm.prank(alice);
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 10 ether);

        // Advance some blocks
        vm.roll(block.number + 100);

        // Check pending rewards (if reward system is active)
        uint256 pending = LiquidityPoolFacet(address(diamond)).getPendingRewards(alice, poolId);

        // Note: This will be 0 unless reward rate is configured
        // In production, this would be set up during pool creation
        assertEq(pending, 0); // Default reward rate is 0
    }

    function test_RevertWhen_SwapExceedsSlippage() public {
        // Create pool and add liquidity
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        vm.prank(alice);
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 20 ether);

        uint256 amountIn = 1 ether;
        (uint256 expectedOut, ) = LiquidityPoolFacet(address(diamond)).getSwapOutput(poolId, amountIn, true);

        // Set unrealistic minimum output
        uint256 unrealisticMin = expectedOut * 2;

        vm.prank(bob);
        vm.expectRevert("Slippage exceeded");
        LiquidityPoolFacet(address(diamond)).swap(
            poolId,
            amountIn,
            unrealisticMin,
            true
        );
    }

    function test_RevertWhen_RemoveMoreLiquidityThanOwned() public {
        // Create pool and add liquidity
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        vm.prank(alice);
        uint256 shares = LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 10 ether);

        // Try to remove more shares than owned
        vm.prank(alice);
        vm.expectRevert("Insufficient shares");
        LiquidityPoolFacet(address(diamond)).removeLiquidity(poolId, shares + 1 ether);
    }

    function test_RevertWhen_SwapWithInactivePool() public {
        // Create pool
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        // Deactivate the pool (admin function)
        LiquidityPoolFacet(address(diamond)).setPoolActive(poolId, false);

        vm.prank(bob);
        vm.expectRevert("Pool not active");
        LiquidityPoolFacet(address(diamond)).swap(poolId, 1 ether, 0, true);
    }

    function testImpermanentLoss() public {
        // Create pool and add liquidity at 1:1 ratio
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        vm.prank(alice);
        uint256 depositAmount = 10 ether;
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, depositAmount);

        (uint256 initialReserveA, uint256 initialReserveB) =
            LiquidityPoolFacet(address(diamond)).getReserves(poolId);

        uint256 initialPrice = (initialReserveB * 1e18) / initialReserveA;

        // Large swap changes the ratio significantly
        vm.prank(bob);
        LiquidityPoolFacet(address(diamond)).swap(poolId, 2 ether, 0, true);

        (uint256 newReserveA, uint256 newReserveB) =
            LiquidityPoolFacet(address(diamond)).getReserves(poolId);

        uint256 newPrice = (newReserveB * 1e18) / newReserveA;

        // Calculate impermanent loss
        uint256 il = LiquidityPoolFacet(address(diamond)).getImpermanentLoss(
            alice,
            poolId,
            initialPrice,
            newPrice
        );

        // IL should be non-zero when price changes
        assertGt(il, 0);
    }

    function testUtilizationRate() public {
        // Create pool
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000 // 80% max utilization
        );

        vm.prank(alice);
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 10 ether);

        // Initially no utilization
        uint256 utilization = LiquidityPoolFacet(address(diamond)).getUtilization(poolId);
        assertEq(utilization, 0);

        // Note: Utilization would increase with borrowing/lending features
        // Current implementation focuses on AMM swaps
    }

    function testMultipleSwaps() public {
        // Create pool and add liquidity
        poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId,
            30,
            8000
        );

        vm.prank(alice);
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 50 ether);

        // Perform multiple swaps
        for (uint i = 0; i < 5; i++) {
            vm.prank(bob);
            LiquidityPoolFacet(address(diamond)).swap(
                poolId,
                0.5 ether,
                0,
                i % 2 == 0 // Alternate directions
            );
        }

        // Pool should still be functional
        (uint256 reserveA, uint256 reserveB) = LiquidityPoolFacet(address(diamond)).getReserves(poolId);
        assertGt(reserveA, 0);
        assertGt(reserveB, 0);
    }
}

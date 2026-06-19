// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/PerpetualMarketFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../libraries/LibDiamond.sol";
import "../libraries/LibPerpetual.sol";
import "../libraries/LibMarket.sol";

contract PerpetualMarketFacetTest is Test {
    Diamond diamond;
    DiamondCutFacet diamondCutFacet;
    DiamondLoupeFacet diamondLoupeFacet;
    PerpetualMarketFacet perpetualFacet;
    PredictionMarketFacet predictionFacet;

    address owner = address(this);
    address alice = address(0x1);
    address bob = address(0x2);
    address oracle = address(0x3);

    bytes32 marketId;

    event PerpetualMarketCreated(bytes32 indexed marketId, string symbol, address indexed indexOracle);
    event PositionOpened(bytes32 indexed marketId, address indexed trader, LibPerpetual.Side side, uint256 size, uint256 collateral, uint256 entryPrice);
    event PositionClosed(bytes32 indexed marketId, address indexed trader, uint256 pnl);
    event PositionLiquidated(bytes32 indexed marketId, address indexed trader, address indexed liquidator, uint256 liquidationFee);
    event FundingRateUpdated(bytes32 indexed marketId, uint256 fundingRate);

    /// @notice Helper to mock oracle price with fresh timestamp (for staleness check)
    function mockOraclePrice(int256 price) internal {
        // Mock latestRoundData for staleness-aware oracle check
        vm.mockCall(
            oracle,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(
                uint80(1),           // roundId
                price,               // answer
                block.timestamp,     // startedAt
                block.timestamp,     // updatedAt (fresh)
                uint80(1)            // answeredInRound
            )
        );
        // Also mock latestAnswer for fallback
        vm.mockCall(
            oracle,
            abi.encodeWithSignature("latestAnswer()"),
            abi.encode(price)
        );
    }

    function setUp() public {
        // Deploy facets
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        perpetualFacet = new PerpetualMarketFacet();
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

        // Build diamond cut for PerpetualMarketFacet
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);

        // PerpetualMarketFacet
        bytes4[] memory perpetualSelectors = new bytes4[](10);
        perpetualSelectors[0] = PerpetualMarketFacet.createPerpetualMarket.selector;
        perpetualSelectors[1] = PerpetualMarketFacet.openPosition.selector;
        perpetualSelectors[2] = PerpetualMarketFacet.closePosition.selector;
        perpetualSelectors[3] = PerpetualMarketFacet.liquidatePosition.selector;
        perpetualSelectors[4] = PerpetualMarketFacet.updateFundingRate.selector;
        perpetualSelectors[5] = PerpetualMarketFacet.getPerpetualMarket.selector;
        perpetualSelectors[6] = PerpetualMarketFacet.getPosition.selector;
        perpetualSelectors[7] = PerpetualMarketFacet.getMarkPrice.selector;
        perpetualSelectors[8] = PerpetualMarketFacet.getFundingRate.selector;
        perpetualSelectors[9] = PerpetualMarketFacet.getLiquidationPrice.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(perpetualFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: perpetualSelectors
        });

        // Add perpetual facet via diamond cut
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

        // Setup users with balances (increased for realistic perp testing)
        vm.deal(alice, 100000 ether);
        vm.deal(bob, 100000 ether);

        vm.prank(alice);
        PredictionMarketFacet(address(diamond)).deposit{value: 60000 ether}();

        vm.prank(bob);
        PredictionMarketFacet(address(diamond)).deposit{value: 20000 ether}();
    }

    function testCreatePerpetualMarket() public {
        vm.expectEmit(false, false, false, true); // Skip marketId check (dynamically generated)
        emit PerpetualMarketCreated(bytes32(0), "BTC-PERP", oracle);

        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10, // 10x max leverage
            500, // 5% maintenance margin
            1000, // 10% initial margin
            250, // 2.5% liquidation fee
            10, // 0.1% maker fee
            20 // 0.2% taker fee
        );

        (
            string memory symbol,
            address indexOracle,
            uint256 fundingRate,
            uint256 maxLeverage,
            uint256 maintenanceMarginRate,
            bool active
        ) = PerpetualMarketFacet(address(diamond)).getPerpetualMarket(marketId);

        assertEq(symbol, "BTC-PERP");
        assertEq(indexOracle, oracle);
        assertEq(fundingRate, 0);
        assertEq(maxLeverage, 10);
        assertEq(maintenanceMarginRate, 500);
        assertTrue(active);
    }

    function testOpenLongPosition() public {
        // Create market
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500,
            1000,
            250,
            10,
            20
        );

        // Mock oracle price
        mockOraclePrice(50000e8); // $50,000

        uint256 size = 1e18; // 1 BTC position
        uint256 collateral = 5100 ether; // Collateral for ~9.8x leverage (BTC at $50k)
        uint256 maxPrice = 51000e8; // Max $51,000 in 8 decimals

        vm.expectEmit(true, true, false, true);
        emit PositionOpened(marketId, alice, LibPerpetual.Side.LONG, size, collateral, 50000e8);

        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            size,
            collateral,
            maxPrice
        );

        (
            LibPerpetual.Side side,
            uint256 positionSize,
            uint256 positionCollateral,
            uint256 entryPrice,
            ,
            ,
        ) = PerpetualMarketFacet(address(diamond)).getPosition(alice, marketId);

        assertEq(uint8(side), uint8(LibPerpetual.Side.LONG));
        assertEq(positionSize, size);
        assertEq(positionCollateral, collateral);
        assertEq(entryPrice, 50000e8); // 8 decimals
    }

    function testOpenShortPosition() public {
        // Create market
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500,
            1000,
            250,
            10,
            20
        );

        // Mock oracle price
        mockOraclePrice(50000e8);

        uint256 size = 1e18;
        uint256 collateral = 5000 ether; // Collateral for ~10x leverage
        uint256 maxPrice = 51000e8; // 8 decimals

        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.SHORT,
            size,
            collateral,
            maxPrice
        );

        (
            LibPerpetual.Side side,
            uint256 positionSize,
            uint256 positionCollateral,
            uint256 entryPrice,
            ,
            ,
        ) = PerpetualMarketFacet(address(diamond)).getPosition(alice, marketId);

        assertEq(uint8(side), uint8(LibPerpetual.Side.SHORT));
        assertEq(positionSize, size);
        assertEq(positionCollateral, collateral);
        assertEq(entryPrice, 50000e8); // 8 decimals
    }

    function testClosePositionWithProfit() public {
        // Create market and open long position
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500,
            1000,
            250,
            10,
            20
        );

        // Entry at $50,000
        mockOraclePrice(50000e8);

        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            1e18,
            5000 ether,
            51000e8
        );

        uint256 balanceBefore = PredictionMarketFacet(address(diamond)).getBalance(alice);

        // Price increases to $55,000 (profit)
        mockOraclePrice(55000e8);

        vm.expectEmit(true, true, false, false);
        emit PositionClosed(marketId, alice, 0); // PnL checked separately

        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).closePosition(marketId, 45000e8);

        uint256 balanceAfter = PredictionMarketFacet(address(diamond)).getBalance(alice);

        // Balance should increase (collateral + profit - fees)
        assertGt(balanceAfter, balanceBefore);
    }

    function testClosePositionWithLoss() public {
        // Create market and open long position
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500,
            1000,
            250,
            10,
            20
        );

        // Entry at $50,000
        mockOraclePrice(50000e8);

        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            1e18,
            5000 ether,
            51000e8
        );

        uint256 balanceBefore = PredictionMarketFacet(address(diamond)).getBalance(alice);

        // Price decreases to $45,000 (loss)
        mockOraclePrice(45000e8);

        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).closePosition(marketId, 40000e8);

        uint256 balanceAfter = PredictionMarketFacet(address(diamond)).getBalance(alice);

        // Balance should be less than initial (collateral - loss - fees)
        assertLt(balanceAfter, balanceBefore);
    }

    function testLiquidation() public {
        // Create market
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500, // 5% maintenance margin
            1000,
            250,
            10,
            20
        );

        // Entry at $50,000 with 10x leverage
        mockOraclePrice(50000e8);

        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            10e18, // 10 BTC
            50000 ether, // Collateral for ~10x leverage
            51000e8
        );

        // Price drops significantly to trigger liquidation
        mockOraclePrice(47000e8); // ~6% loss, below maintenance margin

        vm.expectEmit(false, true, true, false); // Skip marketId check
        emit PositionLiquidated(marketId, alice, bob, 0); // liquidationFee not checked

        vm.prank(bob);
        PerpetualMarketFacet(address(diamond)).liquidatePosition(marketId, alice);

        // Position should be closed
        (
            ,
            uint256 positionSize,
            ,
            ,
            ,
            ,
        ) = PerpetualMarketFacet(address(diamond)).getPosition(alice, marketId);

        assertEq(positionSize, 0);
    }

    function testFundingRateUpdate() public {
        // Create market
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500,
            1000,
            250,
            10,
            20
        );

        // Mock oracle
        mockOraclePrice(50000e8);

        // Open more longs than shorts to create imbalance
        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            10e18,
            50000 ether,
            51000e8
        );

        vm.prank(bob);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.SHORT,
            2e18,
            10000 ether,
            51000e8
        );

        // Advance time by 1 hour
        vm.warp(block.timestamp + 1 hours);

        vm.expectEmit(true, false, false, false);
        emit FundingRateUpdated(marketId, 0);

        PerpetualMarketFacet(address(diamond)).updateFundingRate(marketId);

        (, , uint256 fundingRate, , , ) = PerpetualMarketFacet(address(diamond)).getPerpetualMarket(marketId);

        // Funding rate should be positive (longs pay shorts)
        assertGt(fundingRate, 0);
    }

    function test_RevertWhen_OpenPositionWithExcessiveLeverage() public {
        // Create market with max 10x leverage
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500,
            1000,
            250,
            10,
            20
        );

        mockOraclePrice(50000e8);

        // Try to open 15x leverage position (should fail with 10x max)
        vm.prank(alice);
        vm.expectRevert("Leverage too high");
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            20e18, // 20 BTC
            66666 ether, // Collateral for ~15x leverage (should fail)
            51000e8
        );
    }

    function test_RevertWhen_OpenPositionWithInsufficientCollateral() public {
        // Create market
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500,
            1500, // 15% initial margin required
            250,
            10,
            20
        );

        mockOraclePrice(50000e8);

        // Try to open position with insufficient collateral
        // With 15% margin, requires 7500 ether for 1 BTC at $50k
        // Using 5500 ether: passes leverage check (~9x) but fails margin requirement
        vm.prank(alice);
        vm.expectRevert("Insufficient collateral");
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            1e18,
            5500 ether, // Passes leverage but below 15% margin
            51000e8
        );
    }

    function test_RevertWhen_LiquidateHealthyPosition() public {
        // Create market
        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10,
            500,
            1000,
            250,
            10,
            20
        );

        mockOraclePrice(50000e8);

        vm.prank(alice);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            1e18,
            5000 ether,
            51000e8
        );

        // Price only slightly down - position still healthy
        mockOraclePrice(49000e8);

        // Should fail to liquidate
        vm.prank(bob);
        vm.expectRevert("Position not liquidatable");
        PerpetualMarketFacet(address(diamond)).liquidatePosition(marketId, alice);
    }
}

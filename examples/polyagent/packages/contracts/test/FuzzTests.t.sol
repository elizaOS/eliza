// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../core/LiquidityPoolFacet.sol";
import "../core/ReferralSystemFacet.sol";
import "../libraries/LibDiamond.sol";
import "../identity/ERC8004IdentityRegistry.sol";
import "../identity/ERC8004ReputationSystem.sol";
import "../src/game/PolyagentGameOracle.sol";

/// @title FuzzTests
/// @notice Comprehensive fuzz testing for all contracts
/// @dev Foundry's built-in fuzzer with configurable runs
contract FuzzTests is Test {
    Diamond diamond;
    DiamondCutFacet diamondCutFacet;
    DiamondLoupeFacet diamondLoupeFacet;
    PredictionMarketFacet predictionMarketFacet;
    LiquidityPoolFacet liquidityPoolFacet;
    ReferralSystemFacet referralSystemFacet;
    ERC8004IdentityRegistry identityRegistry;
    ERC8004ReputationSystem reputationSystem;
    PolyagentGameOracle polyagentOracle;

    address owner;
    address user1;
    address user2;
    address gameServer;

    uint256 constant MAX_AMOUNT = 1e30;
    uint256 constant MIN_AMOUNT = 1e15;

    function setUp() public virtual {
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");
        gameServer = makeAddr("gameServer");

        vm.deal(user1, 100 ether);
        vm.deal(user2, 100 ether);

        // Deploy facets
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        predictionMarketFacet = new PredictionMarketFacet();
        liquidityPoolFacet = new LiquidityPoolFacet();
        referralSystemFacet = new ReferralSystemFacet();

        // Deploy Diamond
        diamond = new Diamond(address(diamondCutFacet), address(diamondLoupeFacet));

        // Setup facets
        _setupDiamondFacets();

        // Deploy identity contracts
        identityRegistry = new ERC8004IdentityRegistry();
        reputationSystem = new ERC8004ReputationSystem(address(identityRegistry));

        // Deploy oracle
        polyagentOracle = new PolyagentGameOracle(gameServer);
    }

    function _setupDiamondFacets() internal {
        // Add DiamondLoupeFacet
        bytes4[] memory loupeSelectors = new bytes4[](4);
        loupeSelectors[0] = DiamondLoupeFacet.facets.selector;
        loupeSelectors[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSelectors[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSelectors[3] = DiamondLoupeFacet.facetAddress.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: loupeSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Add PredictionMarketFacet
        bytes4[] memory pmSelectors = new bytes4[](13);
        pmSelectors[0] = PredictionMarketFacet.createMarket.selector;
        pmSelectors[1] = PredictionMarketFacet.calculateCost.selector;
        pmSelectors[2] = PredictionMarketFacet.buyShares.selector;
        pmSelectors[3] = PredictionMarketFacet.sellShares.selector;
        pmSelectors[4] = PredictionMarketFacet.calculateSellPayout.selector;
        pmSelectors[5] = PredictionMarketFacet.resolveMarket.selector;
        pmSelectors[6] = PredictionMarketFacet.claimWinnings.selector;
        pmSelectors[7] = PredictionMarketFacet.deposit.selector;
        pmSelectors[8] = PredictionMarketFacet.withdraw.selector;
        pmSelectors[9] = PredictionMarketFacet.getBalance.selector;
        pmSelectors[10] = PredictionMarketFacet.getMarket.selector;
        pmSelectors[11] = PredictionMarketFacet.getMarketShares.selector;
        pmSelectors[12] = PredictionMarketFacet.getPosition.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(predictionMarketFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: pmSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Add LiquidityPoolFacet
        bytes4[] memory lpSelectors = new bytes4[](12);
        lpSelectors[0] = LiquidityPoolFacet.createLiquidityPool.selector;
        lpSelectors[1] = LiquidityPoolFacet.addLiquidity.selector;
        lpSelectors[2] = LiquidityPoolFacet.removeLiquidity.selector;
        lpSelectors[3] = LiquidityPoolFacet.swap.selector;
        lpSelectors[4] = LiquidityPoolFacet.setPoolActive.selector;
        lpSelectors[5] = LiquidityPoolFacet.claimRewards.selector;
        lpSelectors[6] = LiquidityPoolFacet.getPool.selector;
        lpSelectors[7] = LiquidityPoolFacet.getLPPosition.selector;
        lpSelectors[8] = LiquidityPoolFacet.getReserves.selector;
        lpSelectors[9] = LiquidityPoolFacet.getSwapOutput.selector;
        lpSelectors[10] = LiquidityPoolFacet.getPriceImpact.selector;
        lpSelectors[11] = LiquidityPoolFacet.getUtilization.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(liquidityPoolFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: lpSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Add ReferralSystemFacet
        bytes4[] memory refSelectors = new bytes4[](8);
        refSelectors[0] = ReferralSystemFacet.registerReferral.selector;
        refSelectors[1] = ReferralSystemFacet.payReferralCommission.selector;
        refSelectors[2] = ReferralSystemFacet.initializeReferralSystem.selector;
        refSelectors[3] = ReferralSystemFacet.getReferralData.selector;
        refSelectors[4] = ReferralSystemFacet.getTierInfo.selector;
        refSelectors[5] = ReferralSystemFacet.getReferralChain.selector;
        refSelectors[6] = ReferralSystemFacet.isReferred.selector;
        refSelectors[7] = ReferralSystemFacet.calculateCommission.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(referralSystemFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: refSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Initialize referral system
        ReferralSystemFacet(address(diamond)).initializeReferralSystem(
            100, 200, 300, 400, // Tier rates
            10, 50, 100 // Tier thresholds
        );
    }

    // ============ PredictionMarket Fuzz Tests ============

    /// @notice Fuzz test for deposit amounts
    function testFuzz_Deposit(uint256 amount) public {
        amount = bound(amount, MIN_AMOUNT, MAX_AMOUNT);

        vm.deal(user1, amount);
        vm.prank(user1);
        PredictionMarketFacet(address(diamond)).deposit{value: amount}();

        assertEq(PredictionMarketFacet(address(diamond)).getBalance(user1), amount);
    }

    /// @notice Fuzz test for withdraw amounts
    function testFuzz_WithdrawUpToBalance(uint256 depositAmount, uint256 withdrawAmount) public {
        depositAmount = bound(depositAmount, MIN_AMOUNT, MAX_AMOUNT);
        
        vm.deal(user1, depositAmount);
        vm.prank(user1);
        PredictionMarketFacet(address(diamond)).deposit{value: depositAmount}();

        withdrawAmount = bound(withdrawAmount, 0, depositAmount);
        
        uint256 balanceBefore = user1.balance;
        vm.prank(user1);
        PredictionMarketFacet(address(diamond)).withdraw(withdrawAmount);
        
        assertEq(PredictionMarketFacet(address(diamond)).getBalance(user1), depositAmount - withdrawAmount);
        assertEq(user1.balance, balanceBefore + withdrawAmount);
    }

    /// @notice Fuzz test for buying shares with various amounts
    function testFuzz_BuyShares(uint256 numShares) public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Will BTC reach $100k?",
            outcomes,
            block.timestamp + 1 days,
            owner
        );

        numShares = bound(numShares, 1, 1000);
        uint256 cost = PredictionMarketFacet(address(diamond)).calculateCost(marketId, 0, numShares);
        
        if (cost > MAX_AMOUNT || cost == 0) return;

        vm.deal(user1, cost * 2);
        vm.prank(user1);
        PredictionMarketFacet(address(diamond)).deposit{value: cost * 2}();

        vm.prank(user1);
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, numShares);

        assertEq(PredictionMarketFacet(address(diamond)).getPosition(user1, marketId, 0), numShares);
    }

    /// @notice Fuzz test for market resolution
    function testFuzz_ResolveMarket(uint8 winningOutcome) public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test market",
            outcomes,
            block.timestamp + 1 days,
            owner
        );

        winningOutcome = uint8(bound(uint256(winningOutcome), 0, 1));
        vm.warp(block.timestamp + 2 days);

        vm.prank(owner);
        PredictionMarketFacet(address(diamond)).resolveMarket(marketId, winningOutcome);

        (,,, bool isResolved, uint8 resolved) = PredictionMarketFacet(address(diamond)).getMarket(marketId);
        assertTrue(isResolved);
        assertEq(resolved, winningOutcome);
    }

    // ============ Identity & Reputation Fuzz Tests ============

    /// @notice Fuzz test for feedback ratings
    function testFuzz_SubmitFeedback(int8 rating) public {
        vm.prank(user1);
        uint256 tokenId = identityRegistry.registerAgent(
            "Test Agent",
            "https://test.com/agent",
            keccak256("caps"),
            "{}"
        );

        rating = int8(int256(bound(int256(rating), -5, 5)));

        vm.prank(user2);
        reputationSystem.submitFeedback(tokenId, rating, "Test feedback");

        (address from, int8 storedRating,,) = reputationSystem.getFeedback(tokenId, 0);
        assertEq(from, user2);
        assertEq(storedRating, rating);
    }

    // ============ PolyagentGameOracle Fuzz Tests ============

    /// @notice Fuzz test for commitment generation and verification
    function testFuzz_OracleCommitReveal(bool outcome, bytes32 salt) public {
        if (salt == bytes32(0)) salt = keccak256("default");

        bytes32 commitment = keccak256(abi.encode(outcome, salt));
        string memory questionId = string(abi.encodePacked("fuzz-q-", uint256(salt)));
        
        vm.prank(gameServer);
        bytes32 sessionId = polyagentOracle.commitPolyagentGame(
            questionId,
            1,
            "Fuzz test question?",
            commitment,
            "test"
        );

        assertTrue(polyagentOracle.commitments(commitment));

        address[] memory winners = new address[](0);
        vm.prank(gameServer);
        polyagentOracle.revealPolyagentGame(sessionId, outcome, salt, "", winners, 0);

        (bool storedOutcome, bool finalized) = polyagentOracle.getOutcome(sessionId);
        assertTrue(finalized);
        assertEq(storedOutcome, outcome);
    }

    // ============ Edge Case Fuzz Tests ============

    /// @notice Fuzz test for overflow protection
    function testFuzz_NoOverflowOnDeposit(uint256 amount1, uint256 amount2) public {
        amount1 = bound(amount1, 0, type(uint128).max);
        amount2 = bound(amount2, 0, type(uint128).max);

        vm.deal(user1, amount1);
        if (amount1 > 0) {
            vm.prank(user1);
            PredictionMarketFacet(address(diamond)).deposit{value: amount1}();
        }

        vm.deal(user2, amount2);
        if (amount2 > 0) {
            vm.prank(user2);
            PredictionMarketFacet(address(diamond)).deposit{value: amount2}();
        }

        assertEq(PredictionMarketFacet(address(diamond)).getBalance(user1), amount1);
        assertEq(PredictionMarketFacet(address(diamond)).getBalance(user2), amount2);
    }

    /// @notice Fuzz test for referral commission bounds
    function testFuzz_ReferralCommissionBounds(uint256 transactionAmount) public {
        transactionAmount = bound(transactionAmount, 1e15, 1e30);

        address referrer = makeAddr("referrer");
        vm.prank(user1);
        ReferralSystemFacet(address(diamond)).registerReferral(referrer);

        uint256 commission = ReferralSystemFacet(address(diamond)).calculateCommission(referrer, transactionAmount);
        
        // Commission should be less than transaction amount
        assertLt(commission, transactionAmount);
    }
}

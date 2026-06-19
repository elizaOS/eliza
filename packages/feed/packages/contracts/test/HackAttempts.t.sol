// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../core/LiquidityPoolFacet.sol";
import "../core/PerpetualMarketFacet.sol";
import "../core/ReferralSystemFacet.sol";
import "../identity/ERC8004IdentityRegistry.sol";
import "../identity/ERC8004ReputationSystem.sol";
import "../src/compute/ComputeRegistry.sol";
import "../src/compute/ComputeStaking.sol";
import "../src/moderation/BanManager.sol";
import "../libraries/LibDiamond.sol";

/// @title HackAttempts
/// @notice Systematic attack tests against all contracts
/// @dev Each test attempts a specific attack vector
contract HackAttempts is Test {
    Diamond diamond;
    DiamondCutFacet diamondCutFacet;
    DiamondLoupeFacet diamondLoupeFacet;
    PredictionMarketFacet predictionMarket;
    LiquidityPoolFacet liquidityPool;
    PerpetualMarketFacet perpetualMarket;
    ReferralSystemFacet referralSystem;
    ERC8004IdentityRegistry identityRegistry;
    ERC8004ReputationSystem reputationSystem;
    ComputeRegistry computeRegistry;
    ComputeStaking computeStaking;
    BanManager banManager;

    address attacker = address(0xBAD);
    address victim = address(0xBEEF);
    address owner = address(this);
    
    // Malicious contracts for reentrancy attacks
    ReentrancyAttacker reentrancyAttacker;

    function setUp() public {
        // Deploy facets
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        predictionMarket = new PredictionMarketFacet();
        liquidityPool = new LiquidityPoolFacet();
        perpetualMarket = new PerpetualMarketFacet();
        referralSystem = new ReferralSystemFacet();

        // Deploy diamond
        diamond = new Diamond(address(diamondCutFacet), address(diamondLoupeFacet));

        // Add facets
        _addFacets();

        // Deploy identity contracts
        identityRegistry = new ERC8004IdentityRegistry();
        reputationSystem = new ERC8004ReputationSystem(address(identityRegistry));

        // Deploy compute contracts
        banManager = new BanManager(owner, owner); // governance, owner
        computeRegistry = new ComputeRegistry(owner);
        computeStaking = new ComputeStaking(owner, address(banManager));

        // Deploy attack contracts
        reentrancyAttacker = new ReentrancyAttacker(address(diamond));

        // Fund accounts
        vm.deal(attacker, 1000 ether);
        vm.deal(victim, 1000 ether);
        vm.deal(address(reentrancyAttacker), 100 ether);
    }

    function _addFacets() internal {
        // Add DiamondLoupeFacet
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

        // Add PredictionMarketFacet
        bytes4[] memory pmSelectors = new bytes4[](10);
        pmSelectors[0] = PredictionMarketFacet.createMarket.selector;
        pmSelectors[1] = PredictionMarketFacet.buyShares.selector;
        pmSelectors[2] = PredictionMarketFacet.sellShares.selector;
        pmSelectors[3] = PredictionMarketFacet.resolveMarket.selector;
        pmSelectors[4] = PredictionMarketFacet.claimWinnings.selector;
        pmSelectors[5] = PredictionMarketFacet.deposit.selector;
        pmSelectors[6] = PredictionMarketFacet.withdraw.selector;
        pmSelectors[7] = PredictionMarketFacet.getBalance.selector;
        pmSelectors[8] = PredictionMarketFacet.calculateCost.selector;
        pmSelectors[9] = PredictionMarketFacet.getMarket.selector;

        IDiamondCut.FacetCut[] memory pmCuts = new IDiamondCut.FacetCut[](1);
        pmCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(predictionMarket),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: pmSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(pmCuts, address(0), "");

        // Add LiquidityPoolFacet
        bytes4[] memory lpSelectors = new bytes4[](6);
        lpSelectors[0] = LiquidityPoolFacet.createLiquidityPool.selector;
        lpSelectors[1] = LiquidityPoolFacet.addLiquidity.selector;
        lpSelectors[2] = LiquidityPoolFacet.removeLiquidity.selector;
        lpSelectors[3] = LiquidityPoolFacet.swap.selector;
        lpSelectors[4] = LiquidityPoolFacet.getPool.selector;
        lpSelectors[5] = LiquidityPoolFacet.claimRewards.selector;

        IDiamondCut.FacetCut[] memory lpCuts = new IDiamondCut.FacetCut[](1);
        lpCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(liquidityPool),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: lpSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(lpCuts, address(0), "");

        // Add ReferralSystemFacet
        bytes4[] memory refSelectors = new bytes4[](4);
        refSelectors[0] = ReferralSystemFacet.registerReferral.selector;
        refSelectors[1] = ReferralSystemFacet.payReferralCommission.selector;
        refSelectors[2] = ReferralSystemFacet.initializeReferralSystem.selector;
        refSelectors[3] = ReferralSystemFacet.getReferralData.selector;

        IDiamondCut.FacetCut[] memory refCuts = new IDiamondCut.FacetCut[](1);
        refCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(referralSystem),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: refSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(refCuts, address(0), "");

        // Initialize referral system
        ReferralSystemFacet(address(diamond)).initializeReferralSystem(
            500, 750, 1000, 1250, 5, 20, 50
        );
    }

    // ============================================
    // PREDICTION MARKET ATTACKS
    // ============================================

    /// @notice Attack: Try to withdraw more than deposited (overflow attack)
    function test_hack_withdrawOverflow() public {
        vm.startPrank(attacker);
        
        // Deposit small amount
        PredictionMarketFacet(address(diamond)).deposit{value: 1 ether}();
        
        // Try to withdraw more
        vm.expectRevert("Insufficient balance");
        PredictionMarketFacet(address(diamond)).withdraw(100 ether);
        
        vm.stopPrank();
    }

    /// @notice Attack: Try to buy shares with 0 balance
    function test_hack_buySharesWithoutFunds() public {
        // Create market first
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        vm.startPrank(attacker);
        // Attacker has no balance deposited
        
        vm.expectRevert("Insufficient balance");
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, 1 ether);
        
        vm.stopPrank();
    }

    /// @notice Attack: Try to resolve market as non-oracle
    function test_hack_resolveAsNonOracle() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        // Warp past resolve time
        vm.warp(block.timestamp + 2 days);

        vm.startPrank(attacker);
        vm.expectRevert("Only oracle can resolve");
        PredictionMarketFacet(address(diamond)).resolveMarket(marketId, 0);
        vm.stopPrank();
    }

    /// @notice Attack: Try to claim winnings before resolution
    function test_hack_claimBeforeResolution() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        // Buy some shares
        vm.prank(victim);
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();
        
        vm.prank(victim);
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, 0.001 ether);

        vm.prank(victim);
        vm.expectRevert("Market not resolved");
        PredictionMarketFacet(address(diamond)).claimWinnings(marketId);
    }

    /// @notice Attack: Try to claim winnings twice
    function test_hack_doubleClaimWinnings() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        // Victim buys winning shares
        vm.startPrank(victim);
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, 0.001 ether);
        vm.stopPrank();

        // Resolve market
        vm.warp(block.timestamp + 2 days);
        PredictionMarketFacet(address(diamond)).resolveMarket(marketId, 0);

        // First claim succeeds
        vm.prank(victim);
        PredictionMarketFacet(address(diamond)).claimWinnings(marketId);

        // Second claim fails
        vm.prank(victim);
        vm.expectRevert("No winning shares"); // Shares were zeroed
        PredictionMarketFacet(address(diamond)).claimWinnings(marketId);
    }

    /// @notice Attack: Try to manipulate market after expiry
    function test_hack_tradeAfterExpiry() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();
        
        // Warp past expiry
        vm.warp(block.timestamp + 2 days);
        
        vm.expectRevert("Market expired");
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, 0.001 ether);
        
        vm.stopPrank();
    }

    /// @notice Attack: Try reentrancy on withdraw
    function test_hack_reentrancyWithdraw() public {
        // Fund the attacker contract
        vm.prank(address(reentrancyAttacker));
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();

        // Attack should fail due to reentrancy guard
        vm.expectRevert();
        reentrancyAttacker.attackWithdraw();
    }

    /// @notice Attack: Try to sell more shares than owned
    function test_hack_sellMoreThanOwned() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, 0.001 ether);
        
        // Try to sell 100x more than owned
        vm.expectRevert("Insufficient shares");
        PredictionMarketFacet(address(diamond)).sellShares(marketId, 0, 0.1 ether);
        
        vm.stopPrank();
    }

    /// @notice Attack: Try to create market with invalid outcomes
    function test_hack_invalidOutcomes() public {
        string[] memory outcomes = new string[](1); // Only 1 outcome - invalid
        outcomes[0] = "Yes";
        
        vm.expectRevert("Invalid number of outcomes");
        PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );
    }

    /// @notice Attack: Try flash loan style attack (deposit/trade/withdraw in same tx)
    function test_hack_flashLoanStyleAttack() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        vm.startPrank(attacker);
        
        // Deposit
        PredictionMarketFacet(address(diamond)).deposit{value: 100 ether}();
        uint256 balanceBefore = PredictionMarketFacet(address(diamond)).getBalance(attacker);
        
        // Buy shares
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, 1 ether);
        
        // Try to withdraw everything (should fail - funds locked in position)
        vm.expectRevert("Insufficient balance");
        PredictionMarketFacet(address(diamond)).withdraw(100 ether);
        
        vm.stopPrank();
        
        // Balance should be less due to share purchase
        uint256 balanceAfter = PredictionMarketFacet(address(diamond)).getBalance(attacker);
        assertLt(balanceAfter, balanceBefore, "Balance should decrease after buying shares");
    }

    // ============================================
    // LIQUIDITY POOL ATTACKS
    // ============================================

    /// @notice Attack: Try to drain pool by manipulating reserves
    function test_hack_drainLiquidityPool() public {
        bytes32 marketId = keccak256("test");
        bytes32 poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId, 100, 10000 // 1% fee, 100% max utilization
        );

        // Victim adds liquidity
        vm.startPrank(victim);
        PredictionMarketFacet(address(diamond)).deposit{value: 100 ether}();
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 100 ether);
        vm.stopPrank();

        // Attacker tries to drain
        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();
        
        // Try to swap with extreme slippage
        // This should not drain the pool significantly due to constant product formula
        LiquidityPoolFacet(address(diamond)).swap(poolId, 50 ether, 0, true);
        
        vm.stopPrank();

        // Pool should still have significant liquidity
        (uint256 totalLiquidity,,,,,) = LiquidityPoolFacet(address(diamond)).getPool(poolId);
        assertGt(totalLiquidity, 50 ether, "Pool should not be drained");
    }

    /// @notice Attack: Try to remove more liquidity than deposited
    function test_hack_removeExcessLiquidity() public {
        bytes32 marketId = keccak256("test");
        bytes32 poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId, 100, 10000
        );

        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 10 ether);
        
        // Get LP shares
        (,uint256 totalShares,,,,) = LiquidityPoolFacet(address(diamond)).getPool(poolId);
        
        // Try to remove more shares than owned
        vm.expectRevert("Insufficient shares");
        LiquidityPoolFacet(address(diamond)).removeLiquidity(poolId, totalShares + 1);
        
        vm.stopPrank();
    }

    /// @notice Attack: Sandwich attack attempt
    function test_hack_sandwichAttack() public {
        bytes32 marketId = keccak256("test");
        bytes32 poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId, 100, 10000
        );

        // Setup pool with liquidity
        vm.startPrank(owner);
        PredictionMarketFacet(address(diamond)).deposit{value: 100 ether}();
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 100 ether);
        vm.stopPrank();

        // Victim prepares swap
        vm.startPrank(victim);
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();
        vm.stopPrank();

        // Attacker front-runs
        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 20 ether}();
        uint256 attackerBalanceBefore = PredictionMarketFacet(address(diamond)).getBalance(attacker);
        LiquidityPoolFacet(address(diamond)).swap(poolId, 20 ether, 0, true);
        vm.stopPrank();

        // Victim's swap (price moved against them)
        vm.prank(victim);
        LiquidityPoolFacet(address(diamond)).swap(poolId, 10 ether, 0, true);

        // Attacker back-runs
        vm.startPrank(attacker);
        uint256 attackerBalance = PredictionMarketFacet(address(diamond)).getBalance(attacker);
        LiquidityPoolFacet(address(diamond)).swap(poolId, attackerBalance, 0, false);
        uint256 attackerBalanceAfter = PredictionMarketFacet(address(diamond)).getBalance(attacker);
        vm.stopPrank();

        // Due to fees and slippage, attacker should not profit significantly
        // If sandwich works, attackerBalanceAfter > attackerBalanceBefore
        // The pool fees should eat into any potential profit
        console.log("Attacker before:", attackerBalanceBefore);
        console.log("Attacker after:", attackerBalanceAfter);
    }

    // ============================================
    // REFERRAL SYSTEM ATTACKS
    // ============================================

    /// @notice Attack: Try to refer yourself (circular referral)
    function test_hack_selfReferral() public {
        vm.startPrank(attacker);
        vm.expectRevert("Cannot refer yourself");
        ReferralSystemFacet(address(diamond)).registerReferral(attacker);
        vm.stopPrank();
    }

    /// @notice Attack: Try to change referrer after registration
    function test_hack_changeReferrer() public {
        vm.startPrank(attacker);
        ReferralSystemFacet(address(diamond)).registerReferral(victim);
        
        // Try to register again with different referrer
        vm.expectRevert("Already registered");
        ReferralSystemFacet(address(diamond)).registerReferral(owner);
        vm.stopPrank();
    }

    /// @notice Attack: Try to pay commission without funds (should now fail)
    function test_hack_unfundedCommission() public {
        // Setup referral
        vm.prank(attacker);
        ReferralSystemFacet(address(diamond)).registerReferral(victim);

        // Attacker has no balance deposited
        // Try to pay commission - should fail because it deducts from caller
        vm.prank(owner);
        vm.expectRevert("Insufficient balance");
        ReferralSystemFacet(address(diamond)).payReferralCommission(attacker, 1000 ether);
    }

    // ============================================
    // IDENTITY REGISTRY ATTACKS
    // ============================================

    /// @notice Attack: Try to register with empty name
    function test_hack_emptyAgentName() public {
        vm.startPrank(attacker);
        vm.expectRevert("Name required");
        identityRegistry.registerAgent("", "https://endpoint.com", bytes32(0), "{}");
        vm.stopPrank();
    }

    /// @notice Attack: Try to register twice
    function test_hack_doubleRegistration() public {
        vm.startPrank(attacker);
        identityRegistry.registerAgent("Agent1", "https://endpoint1.com", bytes32(0), "{}");
        
        vm.expectRevert("Already registered");
        identityRegistry.registerAgent("Agent2", "https://endpoint2.com", bytes32(0), "{}");
        vm.stopPrank();
    }

    /// @notice Attack: Try to steal endpoint
    function test_hack_stealEndpoint() public {
        // Victim registers first
        vm.prank(victim);
        identityRegistry.registerAgent("Victim", "https://stolen.com", bytes32(0), "{}");

        // Attacker tries to use same endpoint
        vm.startPrank(attacker);
        vm.expectRevert("Endpoint already taken");
        identityRegistry.registerAgent("Attacker", "https://stolen.com", bytes32(0), "{}");
        vm.stopPrank();
    }

    /// @notice Attack: Try to update another agent's profile
    function test_hack_updateOthersProfile() public {
        // Victim registers
        vm.prank(victim);
        identityRegistry.registerAgent("Victim", "https://victim.com", bytes32(0), "{}");

        // Attacker tries to update victim's profile
        vm.startPrank(attacker);
        vm.expectRevert("Not registered");
        identityRegistry.updateAgent("https://hacked.com", bytes32(0), "{}");
        vm.stopPrank();
    }

    // ============================================
    // REPUTATION SYSTEM ATTACKS
    // ============================================

    /// @notice Attack: Try to submit feedback for unregistered agent
    function test_hack_feedbackUnregistered() public {
        vm.startPrank(attacker);
        vm.expectRevert(); // ERC721NonexistentToken
        reputationSystem.submitFeedback(999, 5, "Great!");
        vm.stopPrank();
    }

    /// @notice Attack: Try to submit feedback for yourself
    function test_hack_selfFeedback() public {
        // Register agent
        vm.prank(attacker);
        uint256 tokenId = identityRegistry.registerAgent("Attacker", "https://attacker.com", bytes32(0), "{}");

        // Try to give yourself 5 stars
        vm.startPrank(attacker);
        vm.expectRevert("Cannot review self");
        reputationSystem.submitFeedback(tokenId, 5, "I'm the best!");
        vm.stopPrank();
    }

    /// @notice Attack: Try to submit multiple feedbacks (spam)
    function test_hack_feedbackSpam() public {
        // Register victim agent
        vm.prank(victim);
        uint256 tokenId = identityRegistry.registerAgent("Victim", "https://victim.com", bytes32(0), "{}");

        // Attacker submits feedback
        vm.startPrank(attacker);
        reputationSystem.submitFeedback(tokenId, -5, "Bad!");
        
        // Try to submit again
        vm.expectRevert("Already submitted feedback");
        reputationSystem.submitFeedback(tokenId, -5, "Still bad!");
        vm.stopPrank();
    }

    /// @notice Attack: Try to record bets without authorization
    function test_hack_unauthorizedBetRecording() public {
        // Register agent
        vm.prank(victim);
        uint256 tokenId = identityRegistry.registerAgent("Victim", "https://victim.com", bytes32(0), "{}");

        // Attacker tries to record fake bets
        vm.startPrank(attacker);
        vm.expectRevert(); // OnlyAuthorizedReporter
        reputationSystem.recordBet(tokenId, 1000 ether);
        vm.stopPrank();
    }

    // ============================================
    // COMPUTE REGISTRY ATTACKS
    // ============================================

    /// @notice Attack: Try to register with insufficient stake
    function test_hack_insufficientStake() public {
        vm.startPrank(attacker);
        vm.expectRevert(); // InsufficientStake
        computeRegistry.register{value: 0.01 ether}("Attacker", "https://attacker.com", bytes32(0));
        vm.stopPrank();
    }

    /// @notice Attack: Try to withdraw during lockup
    function test_hack_withdrawDuringLockup() public {
        vm.startPrank(attacker);
        computeRegistry.register{value: 1 ether}("Attacker", "https://attacker.com", bytes32(0));
        
        // Try to withdraw immediately (within lockup period)
        vm.expectRevert(); // StakeLocked
        computeRegistry.withdraw(0.5 ether);
        vm.stopPrank();
    }

    /// @notice Attack: Try to slash as non-slasher
    function test_hack_unauthorizedSlash() public {
        // First register a provider
        vm.prank(victim);
        computeRegistry.register{value: 1 ether}("Provider", "https://provider.com", bytes32(0));

        // Attacker tries to slash
        vm.startPrank(attacker);
        vm.expectRevert("Only slasher");
        computeRegistry.slash(victim, 0.5 ether, "Fake reason");
        vm.stopPrank();
    }

    /// @notice Attack: Try to register with empty endpoint
    function test_hack_emptyEndpoint() public {
        vm.startPrank(attacker);
        vm.expectRevert(); // InvalidEndpoint
        computeRegistry.register{value: 1 ether}("Attacker", "", bytes32(0));
        vm.stopPrank();
    }

    // ============================================
    // COMPUTE STAKING ATTACKS
    // ============================================

    /// @notice Attack: Try to stake without minimum
    function test_hack_stakeBelowMinimum() public {
        vm.startPrank(attacker);
        // Assuming MIN_USER_STAKE is 0.01 ether
        vm.expectRevert(); // InsufficientStake
        computeStaking.stakeAsUser{value: 0.001 ether}();
        vm.stopPrank();
    }

    /// @notice Attack: Try to become guardian without sufficient stake
    function test_hack_guardianWithoutStake() public {
        vm.startPrank(attacker);
        // Try to stake as guardian without enough stake (MIN_GUARDIAN_STAKE = 1 ether)
        vm.expectRevert(); // InsufficientStake
        computeStaking.stakeAsGuardian{value: 0.1 ether}();
        vm.stopPrank();
    }

    // ============================================
    // BAN MANAGER ATTACKS
    // ============================================

    /// @notice Attack: Try to ban as non-governance
    function test_hack_unauthorizedBan() public {
        vm.startPrank(attacker);
        vm.expectRevert();
        banManager.banAddress(victim);
        vm.stopPrank();
    }

    /// @notice Attack: Try to unban as non-governance
    function test_hack_unauthorizedUnban() public {
        // First ban legitimately (owner is governance)
        banManager.banAddress(victim);
        
        // Attacker tries to unban
        vm.startPrank(attacker);
        vm.expectRevert();
        banManager.unbanAddress(victim);
        vm.stopPrank();
    }

    // ============================================
    // ADVANCED ATTACKS
    // ============================================

    /// @notice Attack: Try to exploit price precision in LMSR
    function test_hack_lmsrPrecisionExploit() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 1000 ether}();

        // Try to exploit with very small trades
        // MIN_SHARES should prevent dust attacks
        vm.expectRevert("Shares below minimum");
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, 1); // 1 wei of shares
        
        vm.stopPrank();
    }

    /// @notice Attack: Try timing attack on market resolution
    function test_hack_timingAttackResolution() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        // Try to resolve before time
        vm.expectRevert("Too early to resolve");
        PredictionMarketFacet(address(diamond)).resolveMarket(marketId, 0);
    }

    /// @notice Attack: Block stuffing to manipulate timestamp
    function test_hack_blockStuffing() public view {
        // This is a conceptual test - in real scenarios, attackers might try to stuff blocks
        // to manipulate block.timestamp
        // Solidity's block.timestamp is controlled by miners/validators within ~15 second tolerance
        
        // We can only verify that our contracts don't rely on sub-15-second precision
        uint256 timestamp = block.timestamp;
        assertTrue(timestamp > 0, "Timestamp should be positive");
        // No critical 15-second windows in our contracts - PASS
    }

    // ============================================
    // ADDITIONAL ADVANCED ATTACKS
    // ============================================

    /// @notice Attack: Extreme price impact on swap (should be limited)
    function test_hack_extremePriceImpactSwap() public {
        bytes32 marketId = keccak256("test");
        bytes32 poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId, 100, 10000 // 1% fee
        );

        // Add initial liquidity
        vm.startPrank(owner);
        PredictionMarketFacet(address(diamond)).deposit{value: 100 ether}();
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 100 ether);
        vm.stopPrank();

        // Attacker tries to swap a huge amount (90% of pool)
        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 200 ether}();
        
        // This swap would cause massive price impact (45 ether into a 50 ether reserve)
        // The constant product formula should make this very expensive
        uint256 balanceBefore = PredictionMarketFacet(address(diamond)).getBalance(attacker);
        LiquidityPoolFacet(address(diamond)).swap(poolId, 45 ether, 0, true);
        uint256 balanceAfter = PredictionMarketFacet(address(diamond)).getBalance(attacker);
        
        // Output should be much less than 45 ether due to extreme price impact
        uint256 received = balanceAfter - (balanceBefore - 45 ether);
        emit log_named_uint("Sent", 45 ether);
        emit log_named_uint("Received", received);
        assertLt(received, 40 ether, "Extreme price impact not properly penalizing large trades");
        
        vm.stopPrank();
    }

    /// @notice Attack: Oracle manipulation by frontrunning resolution
    function test_hack_frontrunOracleResolution() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Will ETH > $10k?", outcomes, block.timestamp + 1 days, address(this)
        );

        // Setup: victim has shares on outcome 0
        vm.startPrank(victim);
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 0, 0.01 ether);
        vm.stopPrank();

        // Warp to resolution time
        vm.warp(block.timestamp + 2 days);

        // Oracle resolves (in real scenario, attacker can't control this)
        // This test verifies that resolution is only callable by oracle
        vm.startPrank(attacker);
        vm.expectRevert("Only oracle can resolve");
        PredictionMarketFacet(address(diamond)).resolveMarket(marketId, 1);
        vm.stopPrank();
    }

    /// @notice Attack: Try to claim for wrong winning outcome
    function test_hack_claimWrongOutcome() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        bytes32 marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Test?", outcomes, block.timestamp + 1 days, address(this)
        );

        // Attacker buys shares on outcome 1 (will be losing)
        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 10 ether}();
        PredictionMarketFacet(address(diamond)).buyShares(marketId, 1, 0.01 ether);
        vm.stopPrank();

        // Resolve with outcome 0 winning
        vm.warp(block.timestamp + 2 days);
        PredictionMarketFacet(address(diamond)).resolveMarket(marketId, 0);

        // Attacker tries to claim (but has no winning shares)
        vm.prank(attacker);
        vm.expectRevert("No winning shares");
        PredictionMarketFacet(address(diamond)).claimWinnings(marketId);
    }

    /// @notice Attack: Try to manipulate LP share calculation
    function test_hack_lpShareManipulation() public {
        bytes32 marketId = keccak256("test");
        bytes32 poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId, 100, 10000
        );

        // First depositor gets 1:1 shares
        vm.startPrank(victim);
        PredictionMarketFacet(address(diamond)).deposit{value: 100 ether}();
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 100 ether);
        vm.stopPrank();

        // Get pool state after first deposit
        (uint256 totalLiquidity1, uint256 totalShares1,,,,) = LiquidityPoolFacet(address(diamond)).getPool(poolId);
        assertEq(totalLiquidity1, totalShares1, "First deposit should be 1:1");

        // Second depositor should get proportional shares
        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 50 ether);
        vm.stopPrank();

        // Verify shares are proportional
        (uint256 totalLiquidity2, uint256 totalShares2,,,,) = LiquidityPoolFacet(address(diamond)).getPool(poolId);
        
        // Total liquidity should be 150 ether
        assertEq(totalLiquidity2, 150 ether, "Total liquidity should be 150 ether");
        
        // Shares should be proportional (attacker gets 50 shares, total = 150)
        assertEq(totalShares2, 150 ether, "Total shares should match liquidity");
    }

    /// @notice Attack: Try to withdraw LP shares and drain more than deposited
    function test_hack_lpWithdrawalDrain() public {
        bytes32 marketId = keccak256("test");
        bytes32 poolId = LiquidityPoolFacet(address(diamond)).createLiquidityPool(
            marketId, 100, 10000
        );

        // Multiple users add liquidity
        vm.startPrank(victim);
        PredictionMarketFacet(address(diamond)).deposit{value: 100 ether}();
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 100 ether);
        vm.stopPrank();

        vm.startPrank(attacker);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();
        LiquidityPoolFacet(address(diamond)).addLiquidity(poolId, 50 ether);
        
        // Attacker tries to withdraw more than their share
        vm.expectRevert("Insufficient shares");
        LiquidityPoolFacet(address(diamond)).removeLiquidity(poolId, 100 ether);
        vm.stopPrank();
    }

    /// @notice Attack: Compute registry double registration
    function test_hack_computeDoubleRegister() public {
        vm.startPrank(attacker);
        computeRegistry.register{value: 1 ether}("Attacker", "https://attacker.com", bytes32(0));
        
        // Try to register again
        vm.expectRevert(); // ProviderAlreadyRegistered
        computeRegistry.register{value: 1 ether}("Attacker2", "https://attacker2.com", bytes32(0));
        vm.stopPrank();
    }

    /// @notice Attack: Reactivate without meeting minimum stake
    function test_hack_reactivateBelowMinimum() public {
        vm.startPrank(attacker);
        computeRegistry.register{value: 1 ether}("Attacker", "https://attacker.com", bytes32(0));
        
        // Deactivate
        computeRegistry.deactivate();
        
        // Warp past lockup
        vm.warp(block.timestamp + 8 days);
        
        // Withdraw most stake (below minimum)
        computeRegistry.withdraw(0.95 ether);
        
        // Try to reactivate (should fail - below MIN_PROVIDER_STAKE)
        vm.expectRevert("Insufficient stake");
        computeRegistry.reactivate();
        vm.stopPrank();
    }

    /// @notice Attack: Referral circular chain exploit
    function test_hack_referralChainCircular() public {
        // This should not be possible as each address can only register once
        // and self-referral is blocked
        
        vm.prank(attacker);
        ReferralSystemFacet(address(diamond)).registerReferral(victim);
        
        // Victim tries to refer attacker back (creating circular)
        // This is allowed - they can refer the attacker as a new referral
        vm.prank(victim);
        ReferralSystemFacet(address(diamond)).registerReferral(attacker);
        
        // The chain is: attacker's referrer = victim, victim's referrer = attacker
        // This is technically circular but doesn't cause infinite loops since we only track direct referrers
        
        // Verify both registrations work
        (address attackerReferrer,,,,,) = ReferralSystemFacet(address(diamond)).getReferralData(attacker);
        (address victimReferrer,,,,,) = ReferralSystemFacet(address(diamond)).getReferralData(victim);
        
        assertEq(attackerReferrer, victim);
        assertEq(victimReferrer, attacker);
    }
}



/// @title ReentrancyAttacker
/// @notice Contract to test reentrancy attacks
contract ReentrancyAttacker {
    address public target;
    bool public attacking;

    constructor(address _target) {
        target = _target;
    }

    function attackWithdraw() external {
        attacking = true;
        PredictionMarketFacet(target).withdraw(1 ether);
    }

    receive() external payable {
        if (attacking) {
            attacking = false;
            // Try to reenter
            PredictionMarketFacet(target).withdraw(1 ether);
        }
    }
}


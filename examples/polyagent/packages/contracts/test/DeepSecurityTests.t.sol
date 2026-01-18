// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "./DiamondTestSetup.sol";
import "../core/PredictionMarketFacet.sol";
import "../identity/ERC8004IdentityRegistry.sol";
import "../identity/ERC8004ReputationSystem.sol";
import "../src/game/PolyagentGameOracle.sol";
import "../src/compute/ComputeRegistry.sol";
import "../src/compute/IComputeRegistry.sol";
import "../src/compute/ComputeStaking.sol";
import "../src/compute/LedgerManager.sol";
import "../src/moderation/BanManager.sol";

/**
 * @title DeepSecurityTests
 * @notice Deep security testing - precision attacks, edge cases, griefing, etc.
 */
contract DeepSecurityTests is DiamondTestSetup {
    PredictionMarketFacet internal predictionMarket;
    ERC8004IdentityRegistry internal identityRegistry;
    ERC8004ReputationSystem internal reputationSystem;
    PolyagentGameOracle internal polyagentOracle;
    ComputeRegistry internal computeRegistry;
    BanManager internal banManager;

    address internal attacker = address(0xBAD);
    address internal victim = address(0xF00D);
    bytes32 internal testMarketId;

    function setUp() public override {
        super.setUp();
        predictionMarket = PredictionMarketFacet(address(diamond));
        identityRegistry = new ERC8004IdentityRegistry();
        reputationSystem = new ERC8004ReputationSystem(address(identityRegistry));
        polyagentOracle = new PolyagentGameOracle(owner);
        computeRegistry = new ComputeRegistry(owner);
        banManager = new BanManager(owner, owner);
        
        vm.deal(attacker, 1000 ether);
        vm.deal(victim, 1000 ether);
        
        _setupMarket();
    }

    function _setupMarket() internal {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "No";
        outcomes[1] = "Yes";
        
        vm.warp(block.timestamp + 1);
        testMarketId = predictionMarket.createMarket(
            "Test market?",
            outcomes,
            block.timestamp + 1 days,
            owner
        );
        
        vm.prank(attacker);
        predictionMarket.deposit{value: 100 ether}();
        vm.prank(victim);
        predictionMarket.deposit{value: 100 ether}();
    }

    // ========================================
    // PRECISION/ROUNDING ATTACKS
    // ========================================

    function test_attack_roundingExploit_dustShares() public {
        // Try to exploit rounding by buying very small amounts
        vm.prank(attacker);
        
        // Buy tiny amount of shares - should be blocked by MIN_SHARES
        uint256 dustAmount = 1;
        
        vm.expectRevert("Shares below minimum");
        predictionMarket.buyShares(testMarketId, 1, dustAmount);
        
        // Verify minimum works
        uint256 minShares = 0.0001 ether;
        uint256 cost = predictionMarket.calculateCost(testMarketId, 1, minShares);
        assertTrue(cost > 0, "Cost should be positive for minimum shares");
    }

    function test_attack_roundingExploit_manySmalltrades() public view {
        // Try to exploit by making many small trades vs one big trade
        uint256 totalShares = 1 ether;
        uint256 smallShares = 0.001 ether; // Above MIN_SHARES
        uint256 numTrades = totalShares / smallShares;
        
        // Cost for one big trade
        uint256 bigTradeCost = predictionMarket.calculateCost(testMarketId, 1, totalShares);
        
        // Cost for many small trades (cumulative)
        uint256 smallTradesCost = 0;
        for (uint256 i = 0; i < numTrades; i++) {
            smallTradesCost += predictionMarket.calculateCost(testMarketId, 1, smallShares);
        }
        
        // Small trades should cost MORE or equal (due to LMSR price movement)
        assertTrue(smallTradesCost >= bigTradeCost * 99 / 100, "Small trades should not be cheaper");
    }

    function test_attack_precisionLoss_extremeValues() public {
        vm.prank(attacker);
        
        // Test very large values
        uint256 largeShares = 1000 ether;
        uint256 cost = predictionMarket.calculateCost(testMarketId, 1, largeShares);
        
        // Should handle without overflow
        assertTrue(cost < type(uint256).max / 2, "Cost calculation overflowed");
    }

    // ========================================
    // TIMESTAMP MANIPULATION
    // ========================================

    function test_attack_timestampManipulation_marketExpiry() public {
        // Try to front-run market expiry
        
        // Warp to just before expiry
        vm.warp(block.timestamp + 1 days - 1);
        
        // Trading should still be allowed
        vm.prank(attacker);
        predictionMarket.buyShares(testMarketId, 1, 0.1 ether);
        
        // Warp to exactly expiry
        vm.warp(block.timestamp + 1);
        
        // Trading should now fail
        vm.prank(attacker);
        vm.expectRevert("Market expired");
        predictionMarket.buyShares(testMarketId, 1, 0.1 ether);
    }

    function test_attack_timestampManipulation_futureMarket() public {
        // Try to create market with past resolve time
        string[] memory outcomes = new string[](2);
        outcomes[0] = "No";
        outcomes[1] = "Yes";
        
        vm.expectRevert("Resolve time must be in future");
        predictionMarket.createMarket(
            "Past market?",
            outcomes,
            block.timestamp - 1, // Past time
            owner
        );
    }

    // ========================================
    // STATE MANIPULATION ATTACKS
    // ========================================

    function test_attack_stateManipulation_midTransaction() public {
        // Ensure state changes are atomic
        
        uint256 initialBalance = predictionMarket.getBalance(attacker);
        uint256 sharesToBuy = 1 ether;
        
        // Calculate cost first
        uint256 cost = predictionMarket.calculateCost(testMarketId, 1, sharesToBuy);
        
        // Ensure we have enough balance
        assertTrue(cost <= initialBalance, "Cost exceeds balance");
        
        // Buy shares
        vm.prank(attacker);
        predictionMarket.buyShares(testMarketId, 1, sharesToBuy);
        
        // Balance should be reduced
        uint256 afterBalance = predictionMarket.getBalance(attacker);
        assertEq(afterBalance, initialBalance - cost, "Balance mismatch");
        
        // Position should be updated
        uint256 shares = predictionMarket.getPosition(attacker, testMarketId, 1);
        assertEq(shares, sharesToBuy, "Shares mismatch");
    }

    function test_attack_replayTransaction() public {
        // First commit
        bytes32 salt = bytes32(uint256(111));
        bytes32 commitment = keccak256(abi.encode(true, salt));
        
        vm.prank(owner);
        bytes32 sessionId1 = polyagentOracle.commitPolyagentGame("q1", 1, "Test?", commitment, "test");
        
        // Should work (different question ID) but with different session
        vm.prank(owner);
        bytes32 sessionId2 = polyagentOracle.commitPolyagentGame("q2", 2, "Test2?", commitment, "test");
        
        assertTrue(sessionId1 != sessionId2, "Sessions should be unique");
    }

    // ========================================
    // GRIEFING ATTACKS
    // ========================================

    function test_attack_griefing_frontRunResolution() public {
        // Buy shares early
        vm.prank(victim);
        predictionMarket.buyShares(testMarketId, 1, 1 ether);
        
        // Fast forward to near expiry but not past it
        vm.warp(block.timestamp + 23 hours);
        
        // Attacker tries to front-run resolution by buying same outcome
        vm.prank(attacker);
        predictionMarket.buyShares(testMarketId, 1, 10 ether);
        
        // Fast forward to after expiry
        vm.warp(block.timestamp + 2 hours);
        
        // Resolve (attacker got their shares too)
        vm.prank(owner);
        predictionMarket.resolveMarket(testMarketId, 1);
        
        // Both can claim - no griefing possible
        vm.prank(victim);
        predictionMarket.claimWinnings(testMarketId);
        
        vm.prank(attacker);
        predictionMarket.claimWinnings(testMarketId);
    }

    function test_attack_griefing_dosMarketCreation() public {
        // Try to create many markets to DOS
        string[] memory outcomes = new string[](2);
        outcomes[0] = "No";
        outcomes[1] = "Yes";
        
        // Create 100 markets - should all succeed
        for (uint256 i = 0; i < 100; i++) {
            bytes32 marketId = predictionMarket.createMarket(
                string(abi.encodePacked("Market ", i)),
                outcomes,
                block.timestamp + 1 days,
                owner
            );
            assertTrue(marketId != bytes32(0), "Market creation failed");
        }
    }

    function test_attack_griefing_dustDeposits() public {
        // Try to spam with dust deposits
        for (uint256 i = 0; i < 100; i++) {
            vm.prank(attacker);
            predictionMarket.deposit{value: 1 wei}();
        }
        
        // Balance should accumulate correctly
        uint256 dustBalance = predictionMarket.getBalance(attacker);
        assertTrue(dustBalance >= 100 ether + 100 wei, "Dust not accumulated");
    }

    // ========================================
    // ACCESS CONTROL ATTACKS
    // ========================================

    function test_attack_accessControl_computeRegistry() public {
        // Register as provider
        vm.prank(attacker);
        computeRegistry.register{value: 0.1 ether}("Attacker", "https://evil.com", bytes32(0));
        
        // Try to update another provider's endpoint
        vm.prank(victim);
        computeRegistry.register{value: 0.1 ether}("Victim", "https://victim.com", bytes32(0));
        
        // Verify attacker can only update their own endpoint
        vm.prank(attacker);
        computeRegistry.updateEndpoint("https://new-evil.com"); // Should succeed
        
        // Verify attacker cannot deactivate victim
        // (deactivate is self-only, no cross-user attack vector)
        vm.prank(attacker);
        computeRegistry.deactivate(); // Deactivates attacker's own
        
        // Victim should still be active
        assertTrue(computeRegistry.isActive(victim), "Victim should still be active");
    }

    function test_attack_accessControl_banManager() public {
        // Non-governance cannot ban
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(BanManager.OnlyGovernance.selector));
        banManager.banFromNetwork(1, "malicious", bytes32(0));
    }

    function test_attack_accessControl_oraclePause() public {
        // Non-owner cannot pause
        vm.prank(attacker);
        vm.expectRevert();
        polyagentOracle.pause();
    }

    // ========================================
    // ECONOMIC ATTACKS
    // ========================================

    function test_attack_economic_flashLoanSimulation() public {
        // Simulate flash loan style attack
        // 1. Get large balance
        vm.deal(attacker, 10000 ether);
        vm.prank(attacker);
        predictionMarket.deposit{value: 9000 ether}();
        
        // 2. Buy massive shares
        vm.prank(attacker);
        predictionMarket.buyShares(testMarketId, 1, 100 ether);
        
        // 3. Try to sell immediately for profit - shouldn't work due to LMSR
        vm.prank(attacker);
        uint256 sellPayout = predictionMarket.calculateSellPayout(testMarketId, 1, 100 ether);
        uint256 buyCost = predictionMarket.calculateCost(testMarketId, 1, 100 ether);
        
        // Due to fees and LMSR, sell payout should be less than buy cost
        assertTrue(sellPayout <= buyCost, "Arbitrage opportunity exists");
    }

    function test_attack_economic_manipulatePrice() public {
        // Try to manipulate price significantly
        vm.prank(attacker);
        
        // Buy lots of shares
        predictionMarket.buyShares(testMarketId, 1, 50 ether);
        
        // Check market shares
        uint256 yesShares = predictionMarket.getMarketShares(testMarketId, 1);
        uint256 noShares = predictionMarket.getMarketShares(testMarketId, 0);
        
        // Price should have moved but not break invariants
        assertTrue(yesShares > noShares, "Yes shares should be higher");
    }

    // ========================================
    // EDGE CASE ATTACKS
    // ========================================

    function test_attack_edgeCase_zeroAddressOracle() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "No";
        outcomes[1] = "Yes";
        
        vm.expectRevert("Invalid oracle address");
        predictionMarket.createMarket(
            "Zero oracle?",
            outcomes,
            block.timestamp + 1 days,
            address(0)
        );
    }

    function test_attack_edgeCase_tooManyOutcomes() public {
        string[] memory outcomes = new string[](11); // Max is 10
        for (uint256 i = 0; i < 11; i++) {
            outcomes[i] = string(abi.encodePacked("Outcome", i));
        }
        
        vm.expectRevert("Invalid number of outcomes");
        predictionMarket.createMarket(
            "Too many outcomes?",
            outcomes,
            block.timestamp + 1 days,
            owner
        );
    }

    function test_attack_edgeCase_singleOutcome() public {
        string[] memory outcomes = new string[](1);
        outcomes[0] = "Only";
        
        vm.expectRevert("Invalid number of outcomes");
        predictionMarket.createMarket(
            "Single outcome?",
            outcomes,
            block.timestamp + 1 days,
            owner
        );
    }

    function test_attack_edgeCase_emptyQuestion() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "No";
        outcomes[1] = "Yes";
        
        // Empty question should still work (just weird UX)
        bytes32 marketId = predictionMarket.createMarket(
            "",
            outcomes,
            block.timestamp + 1 days,
            owner
        );
        assertTrue(marketId != bytes32(0), "Empty question market created");
    }

    // ========================================
    // COMPUTE REGISTRY ATTACKS
    // ========================================

    function test_attack_computeRegistry_doubleRegister() public {
        vm.prank(attacker);
        computeRegistry.register{value: 0.1 ether}("Provider1", "https://provider1.com", bytes32(0));
        
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IComputeRegistry.ProviderAlreadyRegistered.selector));
        computeRegistry.register{value: 0.1 ether}("Provider2", "https://provider2.com", bytes32(0));
    }

    function test_attack_computeRegistry_insufficientStake() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IComputeRegistry.InsufficientStake.selector));
        computeRegistry.register{value: 0.01 ether}("Provider", "https://provider.com", bytes32(0));
    }

    function test_attack_computeRegistry_emptyEndpoint() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IComputeRegistry.InvalidEndpoint.selector));
        computeRegistry.register{value: 0.1 ether}("Provider", "", bytes32(0));
    }

    function test_attack_computeRegistry_withdrawLocked() public {
        vm.prank(attacker);
        computeRegistry.register{value: 0.5 ether}("Provider", "https://provider.com", bytes32(0));
        
        // Try to withdraw immediately (should fail - locked)
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IComputeRegistry.StakeLocked.selector));
        computeRegistry.withdraw(0.1 ether);
    }

    function test_attack_computeRegistry_withdrawAfterLockup() public {
        vm.prank(attacker);
        computeRegistry.register{value: 0.5 ether}("Provider", "https://provider.com", bytes32(0));
        
        // Fast forward past lockup
        vm.warp(block.timestamp + 8 days);
        
        // Should be able to withdraw now
        uint256 balanceBefore = attacker.balance;
        vm.prank(attacker);
        computeRegistry.withdraw(0.1 ether);
        uint256 balanceAfter = attacker.balance;
        
        assertEq(balanceAfter - balanceBefore, 0.1 ether, "Withdrawal amount mismatch");
    }

    // ========================================
    // BAN MANAGER ATTACKS
    // ========================================

    function test_attack_banManager_banZeroAgent() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BanManager.InvalidAgentId.selector));
        banManager.banFromNetwork(0, "test", bytes32(0));
    }

    function test_attack_banManager_doubleBan() public {
        vm.prank(owner);
        banManager.banFromNetwork(1, "first ban", bytes32(0));
        
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BanManager.AlreadyBanned.selector));
        banManager.banFromNetwork(1, "second ban", bytes32(0));
    }

    function test_attack_banManager_unbanNotBanned() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BanManager.NotBanned.selector));
        banManager.unbanFromNetwork(1);
    }

    function test_attack_banManager_appBanZeroId() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BanManager.InvalidAppId.selector));
        banManager.banFromApp(1, bytes32(0), "test", bytes32(0));
    }

    // ========================================
    // FUZZ TESTING - DEEP
    // ========================================

    function testFuzz_marketOperationsInvariant(
        uint256 depositAmount,
        uint256 buyAmount,
        uint256 sellAmount
    ) public {
        // Bound inputs - must be above MIN_SHARES (0.0001 ether)
        uint256 MIN_SHARES = 0.0001 ether;
        depositAmount = bound(depositAmount, 0.1 ether, 100 ether);
        buyAmount = bound(buyAmount, MIN_SHARES, depositAmount / 2);
        
        // Deposit
        vm.deal(address(0x123), depositAmount);
        vm.prank(address(0x123));
        predictionMarket.deposit{value: depositAmount}();
        
        uint256 balanceAfterDeposit = predictionMarket.getBalance(address(0x123));
        assertEq(balanceAfterDeposit, depositAmount, "Deposit balance mismatch");
        
        // Buy shares
        vm.prank(address(0x123));
        uint256 cost = predictionMarket.calculateCost(testMarketId, 1, buyAmount);
        
        if (cost <= balanceAfterDeposit) {
            vm.prank(address(0x123));
            predictionMarket.buyShares(testMarketId, 1, buyAmount);
            
            uint256 balanceAfterBuy = predictionMarket.getBalance(address(0x123));
            assertEq(balanceAfterBuy, balanceAfterDeposit - cost, "Buy balance mismatch");
            
            // Sell some back - must be above MIN_SHARES
            sellAmount = bound(sellAmount, 0, buyAmount);
            if (sellAmount >= MIN_SHARES) {
                vm.prank(address(0x123));
                predictionMarket.sellShares(testMarketId, 1, sellAmount);
            }
        }
    }

    function testFuzz_oracleCommitRevealIntegrity(
        bytes32 salt,
        bool outcome,
        uint256 questionNum
    ) public {
        vm.assume(salt != bytes32(0));
        questionNum = bound(questionNum, 1, 1000);
        
        string memory questionId = string(abi.encodePacked("fuzz_q_", questionNum));
        bytes32 commitment = keccak256(abi.encode(outcome, salt));
        
        vm.prank(owner);
        bytes32 sessionId = polyagentOracle.commitPolyagentGame(
            questionId,
            questionNum,
            "Fuzz question?",
            commitment,
            "test"
        );
        
        // Verify cannot reveal with wrong salt
        vm.prank(owner);
        vm.expectRevert("Commitment mismatch");
        polyagentOracle.revealPolyagentGame(
            sessionId,
            outcome,
            bytes32(uint256(salt) + 1), // wrong salt
            "",
            new address[](0),
            0
        );
        
        // Correct reveal should work
        vm.prank(owner);
        polyagentOracle.revealPolyagentGame(sessionId, outcome, salt, "", new address[](0), 0);
        
        // Verify outcome
        (bool resultOutcome, bool finalized) = polyagentOracle.getOutcome(sessionId);
        assertEq(resultOutcome, outcome, "Outcome mismatch");
        assertTrue(finalized, "Should be finalized");
    }

    function testFuzz_identityRegistration(
        string memory name,
        string memory endpoint
    ) public {
        // Bound inputs
        vm.assume(bytes(name).length > 0 && bytes(name).length < 100);
        vm.assume(bytes(endpoint).length > 0 && bytes(endpoint).length < 200);
        
        address newAgent = address(uint160(uint256(keccak256(abi.encode(name, endpoint)))));
        
        vm.prank(newAgent);
        uint256 tokenId = identityRegistry.registerAgent(name, endpoint, bytes32(0), "{}");
        
        assertTrue(tokenId > 0, "Token should be minted");
        assertTrue(identityRegistry.isRegistered(newAgent), "Should be registered");
    }
}


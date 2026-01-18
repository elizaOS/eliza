// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "./DiamondTestSetup.sol";
import "../core/PredictionMarketFacet.sol";
import "../identity/ERC8004IdentityRegistry.sol";
import "../identity/ERC8004ReputationSystem.sol";
import "../src/game/PolyagentGameOracle.sol";

/**
 * @title ComprehensiveAttackTests
 * @notice Exhaustive security tests attempting various attack vectors
 * @dev Focuses on deployed/available contracts
 */
contract ComprehensiveAttackTests is DiamondTestSetup {
    PredictionMarketFacet internal predictionMarket;
    ERC8004IdentityRegistry internal identityRegistry;
    ERC8004ReputationSystem internal reputationSystem;
    PolyagentGameOracle internal polyagentOracle;

    address internal attacker = address(0xBAD);
    address internal victim = address(0xF00D);
    bytes32 internal testMarketId;

    function setUp() public override {
        super.setUp();
        predictionMarket = PredictionMarketFacet(address(diamond));
        identityRegistry = new ERC8004IdentityRegistry();
        reputationSystem = new ERC8004ReputationSystem(address(identityRegistry));
        polyagentOracle = new PolyagentGameOracle(owner);
        
        // Fund attacker and victim
        vm.deal(attacker, 100 ether);
        vm.deal(victim, 100 ether);
        
        // Set up initial state
        _setupMarket();
    }

    function _setupMarket() internal {
        // Create a test market
        string[] memory outcomes = new string[](2);
        outcomes[0] = "No";
        outcomes[1] = "Yes";
        
        vm.warp(block.timestamp + 1);
        testMarketId = predictionMarket.createMarket(
            "Will BTC hit 100k?",
            outcomes,
            block.timestamp + 1 days,
            owner
        );
        
        // Deposit funds for users
        vm.prank(user1);
        predictionMarket.deposit{value: 10 ether}();
        vm.prank(user2);
        predictionMarket.deposit{value: 10 ether}();
        vm.prank(attacker);
        predictionMarket.deposit{value: 10 ether}();
        vm.prank(victim);
        predictionMarket.deposit{value: 10 ether}();
    }

    // ========================================
    // PREDICTION MARKET ATTACKS
    // ========================================

    function test_attack_solvencyDrain() public {
        // Try to drain more than deposited
        vm.prank(attacker);
        
        // Should fail - attacker only has 10 ether deposited
        vm.expectRevert("Insufficient balance");
        predictionMarket.buyShares(testMarketId, 1, 100 ether);
    }

    function test_attack_doubleClaim() public {
        // Buy shares, resolve, claim once, try to claim again
        vm.prank(victim);
        predictionMarket.buyShares(testMarketId, 1, 1 ether);
        
        // Fast forward and resolve
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        predictionMarket.resolveMarket(testMarketId, 1);
        
        // First claim should work
        vm.prank(victim);
        predictionMarket.claimWinnings(testMarketId);
        
        // Second claim should fail - position is cleared, so "No winning shares"
        vm.prank(victim);
        vm.expectRevert("No winning shares");
        predictionMarket.claimWinnings(testMarketId);
    }

    function test_attack_oracleManipulation() public {
        // Try to resolve as non-oracle
        vm.warp(block.timestamp + 2 days);
        
        vm.prank(attacker);
        vm.expectRevert("Only oracle can resolve");
        predictionMarket.resolveMarket(testMarketId, 1);
    }

    function test_attack_earlyResolution() public {
        // Try to resolve before time
        vm.prank(owner);
        vm.expectRevert("Too early to resolve");
        predictionMarket.resolveMarket(testMarketId, 1);
    }

    function test_attack_invalidOutcome() public {
        vm.warp(block.timestamp + 2 days);
        
        // Try to resolve with invalid outcome
        vm.prank(owner);
        vm.expectRevert("Invalid outcome");
        predictionMarket.resolveMarket(testMarketId, 5);
    }

    function test_attack_withdrawMoreThanBalance() public {
        vm.prank(attacker);
        vm.expectRevert("Insufficient balance");
        predictionMarket.withdraw(100 ether);
    }

    function test_attack_reentrancyWithdraw() public {
        // Reentrancy protected by nonReentrant modifier
        // This test verifies the modifier is working
        
        ReentrantAttacker reentrant = new ReentrantAttacker(address(predictionMarket));
        vm.deal(address(reentrant), 10 ether);
        
        // The attacker deposits
        reentrant.deposit();
        
        // Attempt reentrancy - should fail
        vm.expectRevert();
        reentrant.attack();
    }

    function test_attack_marketIdCollision() public {
        // Create multiple markets in same block with same question
        string[] memory outcomes = new string[](2);
        outcomes[0] = "No";
        outcomes[1] = "Yes";
        
        bytes32 id1 = predictionMarket.createMarket(
            "Test?",
            outcomes,
            block.timestamp + 1 days,
            owner
        );
        
        bytes32 id2 = predictionMarket.createMarket(
            "Test?",
            outcomes,
            block.timestamp + 1 days,
            owner
        );
        
        // IDs should be different due to counter
        assertTrue(id1 != id2, "Market IDs should be unique");
    }

    function test_attack_lmsrOverflow() public {
        // Try to cause overflow in LMSR calculation
        vm.prank(attacker);
        
        // Very large share purchase - should handle gracefully
        uint256 maxShares = type(uint128).max;
        
        vm.expectRevert(); // Will revert due to balance or math limits
        predictionMarket.buyShares(testMarketId, 1, maxShares);
    }

    function test_attack_sellMoreThanOwned() public {
        // Buy some shares
        vm.prank(attacker);
        predictionMarket.buyShares(testMarketId, 1, 1 ether);
        
        // Try to sell more
        vm.prank(attacker);
        vm.expectRevert("Insufficient shares");
        predictionMarket.sellShares(testMarketId, 1, 10 ether);
    }

    function test_attack_tradingAfterResolution() public {
        // Resolve market
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        predictionMarket.resolveMarket(testMarketId, 1);
        
        // Try to trade after resolution
        vm.prank(attacker);
        vm.expectRevert("Market already resolved");
        predictionMarket.buyShares(testMarketId, 1, 1 ether);
    }

    function test_attack_tradingAfterExpiry() public {
        // Fast forward past expiry
        vm.warp(block.timestamp + 2 days);
        
        // Try to trade after expiry (before resolution)
        vm.prank(attacker);
        vm.expectRevert("Market expired");
        predictionMarket.buyShares(testMarketId, 1, 1 ether);
    }

    function test_attack_zeroDeposit() public {
        vm.prank(attacker);
        vm.expectRevert("Must deposit some amount");
        predictionMarket.deposit{value: 0}();
    }

    function test_attack_zeroShares() public {
        vm.prank(attacker);
        vm.expectRevert("Shares below minimum");
        predictionMarket.buyShares(testMarketId, 1, 0);
    }

    function test_attack_sellZeroShares() public {
        vm.prank(attacker);
        vm.expectRevert("Shares below minimum");
        predictionMarket.sellShares(testMarketId, 1, 0);
    }

    function test_attack_claimBeforeResolution() public {
        // Buy shares
        vm.prank(victim);
        predictionMarket.buyShares(testMarketId, 1, 1 ether);
        
        // Try to claim before resolution
        vm.prank(victim);
        vm.expectRevert("Market not resolved");
        predictionMarket.claimWinnings(testMarketId);
    }

    function test_attack_claimLosingPosition() public {
        // Buy shares for outcome 0 (No)
        vm.prank(victim);
        predictionMarket.buyShares(testMarketId, 0, 1 ether);
        
        // Resolve with outcome 1 (Yes) as winner
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        predictionMarket.resolveMarket(testMarketId, 1);
        
        // Try to claim losing position
        vm.prank(victim);
        vm.expectRevert("No winning shares");
        predictionMarket.claimWinnings(testMarketId);
    }

    // ========================================
    // POLYAGENT GAME ORACLE ATTACKS
    // ========================================

    function test_attack_oracleUnauthorizedCommit() public {
        vm.prank(attacker);
        vm.expectRevert("Only game server");
        polyagentOracle.commitPolyagentGame(
            "q1",
            1,
            "Will it rain?",
            keccak256(abi.encode(true, bytes32(uint256(1)))),
            "weather"
        );
    }

    function test_attack_oracleDoubleCommit() public {
        bytes32 commitment = keccak256(abi.encode(true, bytes32(uint256(1))));
        
        // First commit
        vm.prank(owner);
        polyagentOracle.commitPolyagentGame("q1", 1, "Test?", commitment, "test");
        
        // Try duplicate
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolyagentGameOracle.QuestionAlreadyCommitted.selector, "q1"));
        polyagentOracle.commitPolyagentGame("q1", 1, "Test?", commitment, "test");
    }

    function test_attack_oracleInvalidReveal() public {
        bytes32 salt = bytes32(uint256(12345));
        bytes32 commitment = keccak256(abi.encode(true, salt));
        
        vm.prank(owner);
        bytes32 sessionId = polyagentOracle.commitPolyagentGame("q1", 1, "Test?", commitment, "test");
        
        // Try reveal with wrong salt
        vm.prank(owner);
        vm.expectRevert("Commitment mismatch");
        polyagentOracle.revealPolyagentGame(
            sessionId,
            true,
            bytes32(uint256(99999)), // wrong salt
            "",
            new address[](0),
            0
        );
    }

    function test_attack_oracleDoubleReveal() public {
        bytes32 salt = bytes32(uint256(12345));
        bytes32 commitment = keccak256(abi.encode(true, salt));
        
        vm.prank(owner);
        bytes32 sessionId = polyagentOracle.commitPolyagentGame("q1", 1, "Test?", commitment, "test");
        
        // First reveal
        vm.prank(owner);
        polyagentOracle.revealPolyagentGame(sessionId, true, salt, "", new address[](0), 0);
        
        // Try second reveal
        vm.prank(owner);
        vm.expectRevert("Already finalized");
        polyagentOracle.revealPolyagentGame(sessionId, false, salt, "", new address[](0), 0);
    }

    function test_attack_oracleUnauthorizedReveal() public {
        bytes32 salt = bytes32(uint256(12345));
        bytes32 commitment = keccak256(abi.encode(true, salt));
        
        vm.prank(owner);
        bytes32 sessionId = polyagentOracle.commitPolyagentGame("q1", 1, "Test?", commitment, "test");
        
        // Attacker tries to reveal
        vm.prank(attacker);
        vm.expectRevert("Only game server");
        polyagentOracle.revealPolyagentGame(sessionId, true, salt, "", new address[](0), 0);
    }

    function test_attack_oracleEmptyQuestionId() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolyagentGameOracle.InvalidQuestionId.selector));
        polyagentOracle.commitPolyagentGame("", 1, "Test?", bytes32(0), "test");
    }

    function test_attack_oracleRevealNonexistent() public {
        bytes32 fakeSessionId = bytes32(uint256(999));
        
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolyagentGameOracle.SessionNotFound.selector, fakeSessionId));
        polyagentOracle.revealPolyagentGame(fakeSessionId, true, bytes32(0), "", new address[](0), 0);
    }

    function test_attack_oracleWrongOutcomeReveal() public {
        bytes32 salt = bytes32(uint256(12345));
        bytes32 commitment = keccak256(abi.encode(true, salt)); // Committed to TRUE
        
        vm.prank(owner);
        bytes32 sessionId = polyagentOracle.commitPolyagentGame("q1", 1, "Test?", commitment, "test");
        
        // Try reveal with wrong outcome (false instead of true)
        vm.prank(owner);
        vm.expectRevert("Commitment mismatch");
        polyagentOracle.revealPolyagentGame(sessionId, false, salt, "", new address[](0), 0);
    }

    // ========================================
    // IDENTITY REGISTRY ATTACKS
    // ========================================

    function test_attack_identityDoubleRegister() public {
        vm.prank(attacker);
        identityRegistry.registerAgent("Agent1", "https://agent1.com", bytes32(0), "{}");
        
        // Try to register again
        vm.prank(attacker);
        vm.expectRevert("Already registered");
        identityRegistry.registerAgent("Agent2", "https://agent2.com", bytes32(0), "{}");
    }

    function test_attack_identityEndpointSquatting() public {
        // Victim registers
        vm.prank(victim);
        identityRegistry.registerAgent("Victim", "https://victim.com", bytes32(0), "{}");
        
        // Attacker tries to squat endpoint
        vm.prank(attacker);
        vm.expectRevert("Endpoint already taken");
        identityRegistry.registerAgent("Attacker", "https://victim.com", bytes32(0), "{}");
    }

    function test_attack_identityUpdateOthers() public {
        // Victim registers
        vm.prank(victim);
        identityRegistry.registerAgent("Victim", "https://victim.com", bytes32(0), "{}");
        
        // Attacker tries to update victim's profile
        vm.prank(attacker);
        vm.expectRevert("Not registered");
        identityRegistry.updateAgent("https://hacked.com", bytes32(0), "{}");
    }

    function test_attack_identityTransferManipulation() public {
        // Register as victim
        vm.prank(victim);
        identityRegistry.registerAgent("Victim", "https://victim.com", bytes32(0), "{}");
        
        uint256 tokenId = identityRegistry.addressToTokenId(victim);
        
        // Attacker cannot transfer
        vm.prank(attacker);
        vm.expectRevert();
        identityRegistry.transferFrom(victim, attacker, tokenId);
    }

    function test_attack_identityEmptyName() public {
        vm.prank(attacker);
        vm.expectRevert("Name required");
        identityRegistry.registerAgent("", "https://test.com", bytes32(0), "{}");
    }

    function test_attack_identityEmptyEndpoint() public {
        vm.prank(attacker);
        vm.expectRevert("Endpoint required");
        identityRegistry.registerAgent("Test", "", bytes32(0), "{}");
    }

    function test_attack_identityDeactivateOthers() public {
        // Victim registers
        vm.prank(victim);
        identityRegistry.registerAgent("Victim", "https://victim.com", bytes32(0), "{}");
        
        // Attacker tries to deactivate
        vm.prank(attacker);
        vm.expectRevert("Not registered");
        identityRegistry.deactivateAgent();
    }

    function test_attack_identityUnlinkWithoutLink() public {
        // Register without linking
        vm.prank(attacker);
        identityRegistry.registerAgent("Test", "https://test.com", bytes32(0), "{}");
        
        // Try to unlink
        vm.prank(attacker);
        vm.expectRevert("No agent0 link");
        identityRegistry.unlinkAgent0Identity();
    }

    // ========================================
    // REPUTATION SYSTEM ATTACKS
    // ========================================

    function test_attack_reputationUnregisteredAgent() public {
        // Try to record bet for unregistered agent
        // ERC721 reverts with ERC721NonexistentToken when ownerOf is called on non-existent token
        vm.prank(owner);
        vm.expectRevert();
        reputationSystem.recordBet(999, 1 ether);
    }

    function test_attack_reputationSubmitFeedbackToSelf() public {
        // Register
        vm.prank(attacker);
        identityRegistry.registerAgent("Attacker", "https://attacker.com", bytes32(0), "{}");
        
        uint256 tokenId = identityRegistry.addressToTokenId(attacker);
        
        // Try to give self feedback
        vm.prank(attacker);
        vm.expectRevert("Cannot review self");
        reputationSystem.submitFeedback(tokenId, 5, "Great!");
    }

    function test_attack_reputationInvalidRating() public {
        // Register two agents
        vm.prank(victim);
        identityRegistry.registerAgent("Victim", "https://victim.com", bytes32(0), "{}");
        
        vm.prank(attacker);
        identityRegistry.registerAgent("Attacker", "https://attacker.com", bytes32(0), "{}");
        
        uint256 victimTokenId = identityRegistry.addressToTokenId(victim);
        
        // Try invalid rating (> 5)
        vm.prank(attacker);
        vm.expectRevert("Invalid rating");
        reputationSystem.submitFeedback(victimTokenId, 10, "Invalid");
    }

    // ========================================
    // GENERAL FUZZING
    // ========================================

    function testFuzz_depositWithdrawIntegrity(uint256 depositAmount, uint256 withdrawAmount) public {
        // Bound to reasonable values
        depositAmount = bound(depositAmount, 0.01 ether, 50 ether);
        withdrawAmount = bound(withdrawAmount, 0, depositAmount);
        
        vm.deal(attacker, depositAmount);
        
        vm.prank(attacker);
        predictionMarket.deposit{value: depositAmount}();
        
        uint256 balanceBefore = predictionMarket.getBalance(attacker);
        assertEq(balanceBefore, depositAmount + 10 ether); // + 10 from setup
        
        vm.prank(attacker);
        predictionMarket.withdraw(withdrawAmount);
        
        uint256 balanceAfter = predictionMarket.getBalance(attacker);
        assertEq(balanceAfter, balanceBefore - withdrawAmount);
    }

    function testFuzz_buySharesCostConsistency(uint256 shares) public view {
        shares = bound(shares, 0.001 ether, 5 ether);
        
        uint256 cost = predictionMarket.calculateCost(testMarketId, 1, shares);
        
        // Cost should always be positive for positive shares
        assertTrue(cost > 0, "Cost should be positive");
        
        // Cost should be less than or equal to shares * 2 (reasonable bound for LMSR)
        assertTrue(cost <= shares * 2, "Cost seems too high");
    }

    function testFuzz_marketCreation(string memory question) public {
        vm.assume(bytes(question).length > 0 && bytes(question).length < 1000);
        
        string[] memory outcomes = new string[](2);
        outcomes[0] = "No";
        outcomes[1] = "Yes";
        
        bytes32 marketId = predictionMarket.createMarket(
            question,
            outcomes,
            block.timestamp + 1 days,
            owner
        );
        
        assertTrue(marketId != bytes32(0), "Market should be created");
    }

    function testFuzz_oracleCommitReveal(bool outcome, bytes32 salt) public {
        vm.assume(salt != bytes32(0));
        
        bytes32 commitment = keccak256(abi.encode(outcome, salt));
        
        vm.prank(owner);
        bytes32 sessionId = polyagentOracle.commitPolyagentGame("fuzz_q", 1, "Fuzz?", commitment, "test");
        
        vm.prank(owner);
        polyagentOracle.revealPolyagentGame(sessionId, outcome, salt, "", new address[](0), 0);
        
        (bool resultOutcome, bool finalized) = polyagentOracle.getOutcome(sessionId);
        assertEq(resultOutcome, outcome);
        assertTrue(finalized);
    }
}

/**
 * @notice Attacker contract for reentrancy tests
 */
contract ReentrantAttacker {
    PredictionMarketFacet public target;
    bool public attacking;
    
    constructor(address _target) {
        target = PredictionMarketFacet(_target);
    }
    
    function deposit() external {
        target.deposit{value: 1 ether}();
    }
    
    function attack() external {
        attacking = true;
        target.withdraw(1 ether);
    }
    
    receive() external payable {
        if (attacking) {
            attacking = false;
            target.withdraw(1 ether);
        }
    }
}

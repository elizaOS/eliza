// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import {PolyagentGameOracle} from "../src/game/PolyagentGameOracle.sol";

/**
 * @title PolyagentGameOracleTest
 * @notice Tests for PolyagentGameOracle - THE GAME IS THE PREDICTION ORACLE
 * @dev Tests the IPredictionOracle implementation that external contracts query
 * 
 * Architecture:
 * - Game engine commits/reveals outcomes via PolyagentGameOracle
 * - PolyagentGameOracle stores outcomes on-chain
 * - External contracts (Diamond, etc.) query getOutcome(sessionId)
 */
contract PolyagentGameOracleTest is Test {
    PolyagentGameOracle public oracle;
    
    address public gameServer = address(0x1);
    address public user1 = address(0x2);
    address public user2 = address(0x3);
    
    bytes32 public sessionId;
    string public questionId = "test-question-1";
    string public question = "Will Bitcoin reach $100k in 2024?";
    bytes32 public commitment;
    bytes32 public salt = keccak256("secret-salt");
    bool public outcome = true;
    
    event PolyagentGameCommitted(
        bytes32 indexed sessionId,
        string questionId,
        uint256 questionNumber,
        string question,
        bytes32 commitment
    );
    
    event PolyagentGameRevealed(
        bytes32 indexed sessionId,
        string questionId,
        bool outcome,
        uint256 winnersCount
    );
    
    function setUp() public {
        // Deploy oracle - THE GAME IS THE PREDICTION ORACLE
        oracle = new PolyagentGameOracle(gameServer);
        
        // Generate commitment
        commitment = keccak256(abi.encode(outcome, salt));
    }
    
    function testCommitGame() public {
        vm.prank(gameServer);
        
        vm.expectEmit(false, false, false, true);
        emit PolyagentGameCommitted(bytes32(0), questionId, 1, question, commitment);
        
        sessionId = oracle.commitPolyagentGame(
            questionId,
            1,  // questionNumber
            question,
            commitment,
            "crypto"  // category
        );
        
        // Verify session was created
        assertTrue(sessionId != bytes32(0), "Session ID should be set");
        
        // Verify metadata
        (string memory storedQuestionId, , , , ) = oracle.gameMetadata(sessionId);
        assertEq(storedQuestionId, questionId, "Question ID should match");
        
        // Verify outcome not finalized yet
        (, bool finalized) = oracle.getOutcome(sessionId);
        assertFalse(finalized, "Should not be finalized");
        
        // Verify statistics
        (uint256 committed, uint256 revealed, uint256 pending) = oracle.getStatistics();
        assertEq(committed, 1, "Should have 1 committed");
        assertEq(revealed, 0, "Should have 0 revealed");
        assertEq(pending, 1, "Should have 1 pending");
    }
    
    function testRevealGame() public {
        // First commit
        vm.prank(gameServer);
        sessionId = oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
        
        // Then reveal
        address[] memory winners = new address[](2);
        winners[0] = user1;
        winners[1] = user2;
        
        vm.prank(gameServer);
        vm.expectEmit(true, false, false, true);
        emit PolyagentGameRevealed(sessionId, questionId, outcome, 2);
        
        oracle.revealPolyagentGame(
            sessionId,
            outcome,
            salt,
            "",  // empty TEE quote
            winners,
            1000 * 10**18  // totalPayout
        );
        
        // Verify outcome is finalized - THIS IS WHAT EXTERNAL CONTRACTS QUERY
        (bool outcomeResult, bool finalized) = oracle.getOutcome(sessionId);
        assertTrue(finalized, "Should be finalized");
        assertEq(outcomeResult, outcome, "Outcome should match");
        
        // Verify winners
        address[] memory storedWinners = oracle.getWinners(sessionId);
        assertEq(storedWinners.length, 2, "Should have 2 winners");
        assertEq(storedWinners[0], user1, "First winner should match");
        assertEq(storedWinners[1], user2, "Second winner should match");
        
        // Verify statistics
        (uint256 committed, uint256 revealed, uint256 pending) = oracle.getStatistics();
        assertEq(committed, 1, "Should have 1 committed");
        assertEq(revealed, 1, "Should have 1 revealed");
        assertEq(pending, 0, "Should have 0 pending");
    }
    
    function testIPredictionOracleInterface() public {
        // Commit game
        vm.prank(gameServer);
        sessionId = oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
        
        // Before reveal: getOutcome returns (false, false)
        (, bool finalizedBefore) = oracle.getOutcome(sessionId);
        assertFalse(finalizedBefore, "Should not be finalized before reveal");
        
        // Reveal game
        address[] memory winners = new address[](1);
        winners[0] = user1;
        
        vm.prank(gameServer);
        oracle.revealPolyagentGame(sessionId, outcome, salt, "", winners, 0);
        
        // After reveal: getOutcome returns (true, true)
        (bool outcomeAfter, bool finalizedAfter) = oracle.getOutcome(sessionId);
        assertTrue(finalizedAfter, "Should be finalized after reveal");
        assertTrue(outcomeAfter, "Outcome should be YES (true)");
        
        // isWinner should work
        assertTrue(oracle.isWinner(sessionId, user1), "User1 should be winner");
        assertFalse(oracle.isWinner(sessionId, user2), "User2 should not be winner");
        
        // verifyCommitment should work
        assertTrue(oracle.verifyCommitment(commitment), "Commitment should exist");
        assertFalse(oracle.verifyCommitment(bytes32(0)), "Zero commitment should not exist");
    }
    
    function testRevealWithInvalidSalt() public {
        // Commit
        vm.prank(gameServer);
        sessionId = oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
        
        // Try to reveal with wrong salt
        bytes32 wrongSalt = keccak256("wrong-salt");
        address[] memory winners = new address[](0);
        
        vm.prank(gameServer);
        vm.expectRevert("Commitment mismatch");
        oracle.revealPolyagentGame(
            sessionId,
            outcome,
            wrongSalt,
            "",
            winners,
            0
        );
    }
    
    function testOnlyGameServerCanCommit() public {
        vm.prank(user1);  // Not game server
        vm.expectRevert("Only game server");
        oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
    }
    
    function testOnlyGameServerCanReveal() public {
        // Commit as game server
        vm.prank(gameServer);
        sessionId = oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
        
        // Try to reveal as user
        address[] memory winners = new address[](0);
        vm.prank(user1);
        vm.expectRevert("Only game server");
        oracle.revealPolyagentGame(
            sessionId,
            outcome,
            salt,
            "",
            winners,
            0
        );
    }
    
    function testBatchCommit() public {
        string[] memory questionIds = new string[](3);
        uint256[] memory questionNumbers = new uint256[](3);
        string[] memory questions = new string[](3);
        bytes32[] memory commitments = new bytes32[](3);
        string[] memory categories = new string[](3);
        
        for (uint i = 0; i < 3; i++) {
            questionIds[i] = string(abi.encodePacked("batch-question-", vm.toString(i)));
            questionNumbers[i] = 100 + i;
            questions[i] = string(abi.encodePacked("Batch Question ", vm.toString(i), "?"));
            commitments[i] = keccak256(abi.encodePacked("batch-commit-", i));
            categories[i] = "batch-test";
        }
        
        // Get current stats
        (uint256 committedBefore, , ) = oracle.getStatistics();
        
        vm.prank(gameServer);
        bytes32[] memory sessionIds = oracle.batchCommitPolyagentGames(
            questionIds,
            questionNumbers,
            questions,
            commitments,
            categories
        );
        
        assertEq(sessionIds.length, 3, "Should create 3 sessions");
        
        (uint256 committedAfter, , ) = oracle.getStatistics();
        assertEq(committedAfter, committedBefore + 3, "Should have 3 more committed");
        
        // Verify each session can be queried via IPredictionOracle
        for (uint i = 0; i < 3; i++) {
            (, bool finalized) = oracle.getOutcome(sessionIds[i]);
            assertFalse(finalized, "Each session should not be finalized yet");
        }
    }
    
    function testPauseUnpause() public {
        oracle.pause();
        
        vm.prank(gameServer);
        vm.expectRevert();
        oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
        
        oracle.unpause();
        
        vm.prank(gameServer);
        sessionId = oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
        
        assertTrue(sessionId != bytes32(0), "Should work after unpause");
    }
    
    function testCannotCommitSameQuestionTwice() public {
        vm.startPrank(gameServer);
        
        oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
        
        vm.expectRevert();
        oracle.commitPolyagentGame(
            questionId,
            2,  // Different question number
            "Different question?",
            commitment,
            "crypto"
        );
        
        vm.stopPrank();
    }
    
    function testQuestionIdMappings() public {
        vm.prank(gameServer);
        sessionId = oracle.commitPolyagentGame(
            questionId,
            1,
            question,
            commitment,
            "crypto"
        );
        
        // Test bidirectional mappings
        bytes32 lookedUpSessionId = oracle.getSessionIdByQuestionId(questionId);
        assertEq(lookedUpSessionId, sessionId, "Session ID lookup should match");
        
        string memory lookedUpQuestionId = oracle.getQuestionIdBySessionId(sessionId);
        assertEq(lookedUpQuestionId, questionId, "Question ID lookup should match");
    }
    
    function testContractMetadata() public view {
        string memory metadata = oracle.getContractMetadata();
        assertTrue(bytes(metadata).length > 0, "Metadata should not be empty");
        // Should contain prediction-oracle type
        assertTrue(
            keccak256(bytes(metadata)) == keccak256(bytes('{"type":"prediction-oracle","subtype":"polyagent-game","name":"Polyagent Game Oracle","category":"social-prediction","version":"1.0.0"}')),
            "Metadata should match expected format"
        );
    }
}

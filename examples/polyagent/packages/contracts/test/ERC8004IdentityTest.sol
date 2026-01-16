// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../identity/ERC8004IdentityRegistry.sol";
import "../identity/ERC8004ReputationSystem.sol";

contract ERC8004IdentityTest is Test {
    ERC8004IdentityRegistry public registry;
    ERC8004ReputationSystem public reputation;

    address public agent1;
    address public agent2;
    address public agent3;

    function setUp() public {
        registry = new ERC8004IdentityRegistry();
        reputation = new ERC8004ReputationSystem(address(registry));

        agent1 = makeAddr("agent1");
        agent2 = makeAddr("agent2");
        agent3 = makeAddr("agent3");
    }

    /// @notice Test agent registration
    function testRegisterAgent() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            '{"strategy": "momentum"}'
        );

        assertEq(tokenId, 1, "First agent should get token ID 1");
        assertTrue(registry.isRegistered(agent1), "Agent should be registered");
        assertEq(registry.getTokenId(agent1), tokenId, "Token ID should match");
        assertEq(registry.ownerOf(tokenId), agent1, "Agent should own the token");
    }

    /// @notice Test duplicate registration prevention
    function testCannotRegisterTwice() public {
        vm.startPrank(agent1);
        registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        vm.expectRevert("Already registered");
        registry.registerAgent(
            "BetaAgent",
            "https://api.example.com/agent1b",
            keccak256("capabilities"),
            "{}"
        );
        vm.stopPrank();
    }

    /// @notice Test endpoint uniqueness
    function testEndpointMustBeUnique() public {
        vm.prank(agent1);
        registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/shared",
            keccak256("capabilities"),
            "{}"
        );

        vm.prank(agent2);
        vm.expectRevert("Endpoint already taken");
        registry.registerAgent(
            "BetaAgent",
            "https://api.example.com/shared",
            keccak256("capabilities"),
            "{}"
        );
    }

    /// @notice Test agent profile retrieval
    function testGetAgentProfile() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("test_capabilities"),
            '{"test": "data"}'
        );

        (
            string memory name,
            string memory endpoint,
            bytes32 capabilitiesHash,
            uint256 registeredAt,
            bool isActive,
            string memory metadata
        ) = registry.getAgentProfile(tokenId);

        assertEq(name, "AlphaAgent");
        assertEq(endpoint, "https://api.example.com/agent1");
        assertEq(capabilitiesHash, keccak256("test_capabilities"));
        assertGt(registeredAt, 0);
        assertTrue(isActive);
        assertEq(metadata, '{"test": "data"}');
    }

    /// @notice Test update agent profile
    function testUpdateAgent() public {
        vm.startPrank(agent1);
        registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        // Update to new endpoint
        registry.updateAgent(
            "https://api.example.com/agent1-v2",
            keccak256("new_capabilities"),
            '{"version": 2}'
        );

        uint256 tokenId = registry.getTokenId(agent1);
        (
            ,
            string memory endpoint,
            bytes32 capabilitiesHash,
            ,
            ,
            string memory metadata
        ) = registry.getAgentProfile(tokenId);

        assertEq(endpoint, "https://api.example.com/agent1-v2");
        assertEq(capabilitiesHash, keccak256("new_capabilities"));
        assertEq(metadata, '{"version": 2}');
        vm.stopPrank();
    }

    /// @notice Test deactivate and reactivate agent
    function testDeactivateReactivate() public {
        vm.startPrank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        registry.deactivateAgent();

        (
            ,
            ,
            ,
            ,
            bool isActive,

        ) = registry.getAgentProfile(tokenId);
        assertFalse(isActive, "Agent should be deactivated");

        registry.reactivateAgent();

        (
            ,
            ,
            ,
            ,
            isActive,

        ) = registry.getAgentProfile(tokenId);
        assertTrue(isActive, "Agent should be reactivated");
        vm.stopPrank();
    }

    /// @notice Test agent verification
    function testVerifyAgent() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        assertTrue(registry.verifyAgent(agent1, tokenId), "Should verify correctly");
        assertFalse(registry.verifyAgent(agent2, tokenId), "Should not verify wrong agent");
    }

    /// @notice Test address mapping updates on transfer
    function testTransferUpdatesMapping() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        // Transfer to agent2
        // Note: ERC721 transferFrom doesn't return a value - it reverts on failure
        // This is expected behavior and safe in test context
        vm.prank(agent1);
        registry.transferFrom(agent1, agent2, tokenId);

        assertEq(registry.getTokenId(agent1), 0, "Old owner should have no token");
        assertEq(registry.getTokenId(agent2), tokenId, "New owner should have token");
        assertEq(registry.ownerOf(tokenId), agent2, "Token owner should be agent2");
    }

    /// @notice Test reputation tracking - record bet
    function testRecordBet() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        reputation.recordBet(tokenId, 1 ether);

        (
            uint256 totalBets,
            ,
            uint256 totalVolume,
            ,
            ,
            ,

        ) = reputation.getReputation(tokenId);

        assertEq(totalBets, 1);
        assertEq(totalVolume, 1 ether);
    }

    /// @notice Test reputation tracking - record win
    function testRecordWin() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        // Record multiple bets
        for (uint256 i = 0; i < 10; i++) {
            reputation.recordBet(tokenId, 1 ether);
        }

        // Record wins
        for (uint256 i = 0; i < 7; i++) {
            reputation.recordWin(tokenId, 0.5 ether);
        }

        (
            uint256 totalBets,
            uint256 winningBets,
            ,
            ,
            uint256 accuracyScore,
            ,

        ) = reputation.getReputation(tokenId);

        assertEq(totalBets, 10);
        assertEq(winningBets, 7);
        assertEq(accuracyScore, 7000, "Accuracy should be 70%");
    }

    /// @notice Test feedback submission
    function testSubmitFeedback() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        vm.prank(agent2);
        reputation.submitFeedback(tokenId, 5, "Excellent performance");

        uint256 feedbackCount = reputation.getFeedbackCount(tokenId);
        assertEq(feedbackCount, 1);

        (
            address from,
            int8 rating,
            string memory comment,

        ) = reputation.getFeedback(tokenId, 0);

        assertEq(from, agent2);
        assertEq(rating, 5);
        assertEq(comment, "Excellent performance");
    }

    /// @notice Test cannot submit feedback twice
    function testCannotSubmitFeedbackTwice() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        vm.startPrank(agent2);
        reputation.submitFeedback(tokenId, 5, "Great");

        vm.expectRevert("Already submitted feedback");
        reputation.submitFeedback(tokenId, 3, "Changed my mind");
        vm.stopPrank();
    }

    /// @notice Test ban/unban functionality
    function testBanUnban() public {
        vm.prank(agent1);
        uint256 tokenId = registry.registerAgent(
            "AlphaAgent",
            "https://api.example.com/agent1",
            keccak256("capabilities"),
            "{}"
        );

        reputation.banAgent(tokenId);

        (
            ,
            ,
            ,
            ,
            ,
            ,
            bool isBanned
        ) = reputation.getReputation(tokenId);
        assertTrue(isBanned);

        reputation.unbanAgent(tokenId);

        (
            ,
            ,
            ,
            ,
            ,
            ,
            isBanned
        ) = reputation.getReputation(tokenId);
        assertFalse(isBanned);
    }
}

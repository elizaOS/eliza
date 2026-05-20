// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./DiamondTestSetup.sol";

contract OracleTest is DiamondTestSetup {
    PredictionMarketFacet public market;
    OracleFacet public oracle;

    function setUp() public override {
        super.setUp();
        market = PredictionMarketFacet(address(diamond));
        oracle = OracleFacet(address(diamond));
    }

    /// @notice Test Chainlink oracle request
    function testChainlinkOracleRequest() public {
        bytes32 marketId = createBasicMarket();

        // Warp to resolution time
        vm.warp(block.timestamp + 31 days);

        // Request oracle resolution
        uint256 oracleFee = chainlinkOracle.fee();
        oracle.requestChainlinkResolution{value: oracleFee}(marketId);

        // Simulate oracle fulfillment
        // Note: Mock request ID would be bytes32(uint256(1))
        // In a real test, we'd capture this from events
    }

    /// @notice Test Chainlink oracle callback
    function testChainlinkOracleCallback() public {
        bytes32 marketId = createBasicMarket();

        // Warp to resolution time
        vm.warp(block.timestamp + 31 days);

        // Request resolution
        uint256 oracleFee = chainlinkOracle.fee();
        oracle.requestChainlinkResolution{value: oracleFee}(marketId);

        // Simulate oracle fulfilling request
        vm.prank(address(chainlinkOracle));
        oracle.oracleCallback(bytes32(uint256(1)), marketId, 0);

        // Verify market is resolved
        (
            ,
            ,
            ,
            bool resolved,
            uint8 winningOutcome
        ) = market.getMarket(marketId);

        assertTrue(resolved, "Market should be resolved");
        assertEq(winningOutcome, 0, "Winning outcome should be 0");
    }

    /// @notice Test mock oracle assertion
    function testMockOracleAssertion() public {
        bytes32 marketId = createBasicMarket();

        // Warp to resolution time
        vm.warp(block.timestamp + 31 days);

        // Request mock resolution with proposed outcome
        uint256 disputeBond = mockOracle.DISPUTE_BOND();
        oracle.requestMockResolution{value: disputeBond}(marketId, 0);

        // Verify assertion was made (would check events in real test)
    }

    /// @notice Test mock assertion settlement without dispute
    function testMockAssertionSettlement() public {
        bytes32 marketId = createBasicMarket();

        // Warp to resolution time
        vm.warp(block.timestamp + 31 days);

        // Make assertion from user1 (so bond can be returned to EOA)
        uint256 disputeBond = mockOracle.DISPUTE_BOND();
        vm.prank(user1);
        bytes32 assertionId = mockOracle.assertTruth{value: disputeBond}(
            marketId,
            bytes32(uint256(0))
        );

        // Warp past liveness period
        vm.warp(block.timestamp + 3 hours);

        // Settle assertion
        mockOracle.settleAssertion(assertionId);

        // Verify oracle state (not testing market resolution since we're calling oracle directly)
        (
            ,
            ,
            ,
            ,
            ,
            ,
            bool resolved,
            bytes32 resolvedOutcome
        ) = mockOracle.getAssertion(assertionId);

        assertTrue(resolved, "Assertion should be resolved");
        assertEq(uint256(resolvedOutcome), 0, "Resolved outcome should be 0");
    }

    /// @notice Test mock assertion dispute and resolution
    function testMockAssertionDispute() public {
        bytes32 marketId = createBasicMarket();

        // Warp to resolution time
        vm.warp(block.timestamp + 31 days);

        // User1 makes assertion
        uint256 disputeBond = mockOracle.DISPUTE_BOND();
        vm.prank(user1);
        bytes32 assertionId = mockOracle.assertTruth{value: disputeBond}(
            marketId,
            bytes32(uint256(0))
        );

        // User2 disputes
        vm.prank(user2);
        mockOracle.disputeAssertion{value: disputeBond}(assertionId);

        // Owner resolves dispute
        mockOracle.resolveDispute(assertionId, bytes32(uint256(1)));

        // Verify oracle state (not testing market resolution since we're calling oracle directly)
        (
            ,
            ,
            ,
            ,
            ,
            bool disputed,
            bool resolved,
            bytes32 resolvedOutcome
        ) = mockOracle.getAssertion(assertionId);

        assertTrue(disputed, "Assertion should be disputed");
        assertTrue(resolved, "Assertion should be resolved");
        assertEq(uint256(resolvedOutcome), 1, "Resolved outcome should be disputed value");
    }

    /// @notice Test manual resolution by owner
    function testManualResolution() public {
        bytes32 marketId = createBasicMarket();

        // Warp to resolution time
        vm.warp(block.timestamp + 31 days);

        // Owner manually resolves
        oracle.manualResolve(marketId, 1);

        // Verify market is resolved
        (
            ,
            ,
            ,
            bool resolved,
            uint8 winningOutcome
        ) = market.getMarket(marketId);

        assertTrue(resolved, "Market should be resolved");
        assertEq(winningOutcome, 1, "Winning outcome should be 1");
    }

    /// @notice Test only oracle can request resolution
    function testOnlyOracleCanRequest() public {
        bytes32 marketId = createBasicMarket();

        // Warp to resolution time
        vm.warp(block.timestamp + 31 days);

        // Non-oracle tries to request
        vm.prank(user1);
        vm.expectRevert("Only oracle can request");
        oracle.requestChainlinkResolution{value: 0.1 ether}(marketId);
    }

    /// @notice Test cannot resolve before resolution time
    function testCannotResolveTooEarly() public {
        bytes32 marketId = createBasicMarket();

        // Try to resolve immediately
        vm.expectRevert("Too early to resolve");
        oracle.requestChainlinkResolution{value: 0.1 ether}(marketId);
    }

    /// @notice Test oracle address getters
    function testGetOracleAddresses() public view {
        (address chainlink, address mock) = oracle.getOracleAddresses();

        assertEq(chainlink, address(chainlinkOracle), "Chainlink address should match");
        assertEq(mock, address(mockOracle), "Mock address should match");
    }

    /// @notice Test set oracle addresses (owner only)
    function testSetOracleAddresses() public {
        address newChainlink = makeAddr("newChainlink");
        address newMock = makeAddr("newMock");

        oracle.setChainlinkOracle(newChainlink);
        oracle.setMockOracle(newMock);

        (address chainlink, address mock) = oracle.getOracleAddresses();

        assertEq(chainlink, newChainlink);
        assertEq(mock, newMock);
    }

    /// @notice Test non-owner cannot set oracle addresses
    function testNonOwnerCannotSetOracles() public {
        address newChainlink = makeAddr("newChainlink");

        vm.prank(user1);
        vm.expectRevert();
        oracle.setChainlinkOracle(newChainlink);
    }

    /// @notice Test full flow with Chainlink oracle
    function testFullFlowWithChainlink() public {
        bytes32 marketId = createBasicMarket();

        // Users buy shares
        vm.startPrank(user1);
        market.deposit{value: 10 ether}();
        market.buyShares(marketId, 0, 2 ether);
        vm.stopPrank();

        vm.startPrank(user2);
        market.deposit{value: 10 ether}();
        market.buyShares(marketId, 1, 2 ether);
        vm.stopPrank();

        // Warp to resolution
        vm.warp(block.timestamp + 31 days);

        // Request and fulfill oracle
        uint256 oracleFee = chainlinkOracle.fee();
        oracle.requestChainlinkResolution{value: oracleFee}(marketId);

        // Simulate oracle callback
        vm.prank(address(chainlinkOracle));
        oracle.oracleCallback(bytes32(uint256(1)), marketId, 0);

        // Winner claims
        vm.prank(user1);
        market.claimWinnings(marketId);

        uint256 balance = market.getBalance(user1);
        assertGt(balance, 10 ether, "Winner should profit");
    }

    /// @notice Test full flow with mock oracle
    function testFullFlowWithMockOracle() public {
        bytes32 marketId = createBasicMarket();

        // Users buy shares
        vm.startPrank(user1);
        market.deposit{value: 10 ether}();
        market.buyShares(marketId, 0, 2 ether);
        vm.stopPrank();

        vm.startPrank(user2);
        market.deposit{value: 10 ether}();
        market.buyShares(marketId, 1, 2 ether);
        vm.stopPrank();

        // Warp to resolution
        vm.warp(block.timestamp + 31 days);

        // Request mock resolution through diamond (oracle is owner in this test)
        uint256 disputeBond = mockOracle.DISPUTE_BOND();
        oracle.requestMockResolution{value: disputeBond}(marketId, 1);

        // Wait for liveness period
        vm.warp(block.timestamp + 3 hours);

        // Find the assertion ID by checking the oracle
        // In production, this would be tracked via events
        // For now, we'll settle manually via callback
        vm.prank(address(mockOracle));
        oracle.mockOracleCallback(marketId, 1);

        // Winner claims
        vm.prank(user2);
        market.claimWinnings(marketId);

        uint256 balance = market.getBalance(user2);
        assertGt(balance, 10 ether, "Winner should profit");
    }
}

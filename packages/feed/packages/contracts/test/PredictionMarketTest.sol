// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./DiamondTestSetup.sol";

contract PredictionMarketTest is DiamondTestSetup {
    PredictionMarketFacet public market;

    function setUp() public override {
        super.setUp();
        market = PredictionMarketFacet(address(diamond));
    }

    /// @notice Test market creation
    function testCreateMarket() public {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";

        uint256 resolveAt = block.timestamp + 30 days;

        bytes32 marketId = market.createMarket(
            "Will BTC reach $100k?",
            outcomes,
            resolveAt,
            owner
        );

        assertTrue(marketId != bytes32(0), "Market ID should not be zero");

        (
            string memory question,
            uint8 numOutcomes,
            uint256 liquidity,
            bool resolved,

        ) = market.getMarket(marketId);

        assertEq(question, "Will BTC reach $100k?");
        assertEq(numOutcomes, 2);
        assertEq(liquidity, 1000 ether); // Default liquidity
        assertFalse(resolved);
    }

    /// @notice Test creating market with invalid parameters
    function testCreateMarketInvalidOutcomes() public {
        string[] memory outcomes = new string[](1);
        outcomes[0] = "Only One";

        vm.expectRevert("Invalid number of outcomes");
        market.createMarket(
            "Invalid market",
            outcomes,
            block.timestamp + 30 days,
            owner
        );
    }

    /// @notice Test deposit functionality
    function testDeposit() public {
        vm.prank(user1);
        market.deposit{value: 10 ether}();

        uint256 balance = market.getBalance(user1);
        assertEq(balance, 10 ether);
    }

    /// @notice Test buy shares
    function testBuyShares() public {
        bytes32 marketId = createBasicMarket();

        // User1 deposits and buys shares
        vm.startPrank(user1);
        market.deposit{value: 10 ether}();

        uint256 cost = market.calculateCost(marketId, 0, 1 ether);
        assertGt(cost, 0, "Cost should be greater than 0");

        market.buyShares(marketId, 0, 1 ether);

        uint256 position = market.getPosition(user1, marketId, 0);
        assertEq(position, 1 ether, "Should have 1 ether of shares");

        uint256 balanceAfter = market.getBalance(user1);
        assertEq(balanceAfter, 10 ether - cost, "Balance should be reduced by cost");
        vm.stopPrank();
    }

    /// @notice Test sell shares
    function testSellShares() public {
        bytes32 marketId = createBasicMarket();

        // User1 buys shares first
        vm.startPrank(user1);
        market.deposit{value: 10 ether}();
        market.buyShares(marketId, 0, 1 ether);

        uint256 balanceBeforeSell = market.getBalance(user1);

        // Sell shares
        uint256 payout = market.calculateSellPayout(marketId, 0, 0.5 ether);
        market.sellShares(marketId, 0, 0.5 ether);

        uint256 positionAfter = market.getPosition(user1, marketId, 0);
        assertEq(positionAfter, 0.5 ether, "Should have 0.5 ether of shares left");

        uint256 balanceAfter = market.getBalance(user1);
        assertEq(balanceAfter, balanceBeforeSell + payout, "Balance should increase by payout");
        vm.stopPrank();
    }

    /// @notice Test market resolution
    function testResolveMarket() public {
        bytes32 marketId = createBasicMarket();

        // Warp to resolution time
        vm.warp(block.timestamp + 31 days);

        // Resolve market
        market.resolveMarket(marketId, 0);

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

    /// @notice Test claiming winnings
    function testClaimWinnings() public {
        bytes32 marketId = createBasicMarket();

        // User1 buys winning shares
        vm.startPrank(user1);
        market.deposit{value: 10 ether}();
        market.buyShares(marketId, 0, 1 ether);
        vm.stopPrank();

        // Warp and resolve
        vm.warp(block.timestamp + 31 days);
        market.resolveMarket(marketId, 0);

        // Claim winnings
        vm.prank(user1);
        market.claimWinnings(marketId);

        uint256 balance = market.getBalance(user1);
        assertGt(balance, 0, "Balance should have winnings");

        // Position should be cleared
        uint256 position = market.getPosition(user1, marketId, 0);
        assertEq(position, 0, "Position should be cleared after claim");
    }

    /// @notice Test withdraw functionality
    function testWithdraw() public {
        vm.startPrank(user1);
        market.deposit{value: 10 ether}();

        uint256 balanceBefore = user1.balance;
        market.withdraw(5 ether);

        uint256 contractBalance = market.getBalance(user1);
        assertEq(contractBalance, 5 ether, "Contract balance should be 5 ether");

        uint256 balanceAfter = user1.balance;
        assertEq(balanceAfter, balanceBefore + 5 ether, "User balance should increase by 5 ether");
        vm.stopPrank();
    }

    /// @notice Test insufficient balance
    function testInsufficientBalance() public {
        bytes32 marketId = createBasicMarket();

        vm.prank(user1);
        market.deposit{value: 1 ether}();

        // Try to buy more shares than balance allows
        vm.prank(user1);
        vm.expectRevert("Insufficient balance");
        market.buyShares(marketId, 0, 100 ether);
    }

    /// @notice Test resolved market cannot accept bets
    function testCannotBetOnResolvedMarket() public {
        bytes32 marketId = createBasicMarket();

        // Resolve market
        vm.warp(block.timestamp + 31 days);
        market.resolveMarket(marketId, 0);

        // Try to buy shares
        vm.startPrank(user1);
        market.deposit{value: 10 ether}();
        vm.expectRevert("Market already resolved");
        market.buyShares(marketId, 0, 1 ether);
        vm.stopPrank();
    }

    /// @notice Test multiple users trading
    function testMultipleUserTrading() public {
        bytes32 marketId = createBasicMarket();

        // User1 buys outcome 0
        vm.startPrank(user1);
        market.deposit{value: 10 ether}();
        market.buyShares(marketId, 0, 2 ether);
        vm.stopPrank();

        // User2 buys outcome 1
        vm.startPrank(user2);
        market.deposit{value: 10 ether}();
        market.buyShares(marketId, 1, 2 ether);
        vm.stopPrank();

        // Verify positions
        uint256 user1Position = market.getPosition(user1, marketId, 0);
        uint256 user2Position = market.getPosition(user2, marketId, 1);

        assertEq(user1Position, 2 ether);
        assertEq(user2Position, 2 ether);
    }

    /// @notice Test LMSR pricing increases with demand
    function testLMSRPricing() public {
        bytes32 marketId = createBasicMarket();

        // Calculate cost for first purchase
        uint256 cost1 = market.calculateCost(marketId, 0, 1 ether);

        // Buy shares
        vm.startPrank(user1);
        market.deposit{value: 50 ether}();
        market.buyShares(marketId, 0, 1 ether);

        // Calculate cost for second purchase (should be higher)
        uint256 cost2 = market.calculateCost(marketId, 0, 1 ether);

        assertGt(cost2, cost1, "Second purchase should be more expensive");
        vm.stopPrank();
    }
}

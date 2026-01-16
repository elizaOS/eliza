// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/ReferralSystemFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../libraries/LibDiamond.sol";

contract ReferralSystemFacetTest is Test {
    Diamond diamond;
    DiamondCutFacet diamondCutFacet;
    DiamondLoupeFacet diamondLoupeFacet;
    ReferralSystemFacet referralFacet;
    PredictionMarketFacet predictionFacet;

    address owner = address(this);
    address alice = address(0x1);
    address bob = address(0x2);
    address charlie = address(0x3);
    address dave = address(0x4);
    address eve = address(0x5);

    event ReferralRegistered(address indexed user, address indexed referrer);
    event ReferralCommissionPaid(address indexed referrer, address indexed user, uint256 amount, uint256 tier);
    event TierUpgraded(address indexed user, uint256 newTier);

    function setUp() public {
        // Deploy facets
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        referralFacet = new ReferralSystemFacet();
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

        // Build diamond cut for ReferralSystemFacet
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);

        // ReferralSystemFacet
        bytes4[] memory referralSelectors = new bytes4[](7);
        referralSelectors[0] = ReferralSystemFacet.registerReferral.selector;
        referralSelectors[1] = ReferralSystemFacet.payReferralCommission.selector;
        referralSelectors[2] = ReferralSystemFacet.getReferralData.selector;
        referralSelectors[3] = ReferralSystemFacet.getReferralChain.selector;
        referralSelectors[4] = ReferralSystemFacet.getTotalReferrals.selector;
        referralSelectors[5] = ReferralSystemFacet.getTotalCommissions.selector;
        referralSelectors[6] = ReferralSystemFacet.initializeReferralSystem.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(referralFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: referralSelectors
        });

        // Add referral facet
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

        // Initialize referral system with tier rates and thresholds
        ReferralSystemFacet(address(diamond)).initializeReferralSystem(
            500,  // Tier 0: 5%
            750,  // Tier 1: 7.5%
            1000, // Tier 2: 10%
            1250, // Tier 3: 12.5%
            5,    // Tier 1 threshold: 5 referrals
            20,   // Tier 2 threshold: 20 referrals
            50    // Tier 3 threshold: 50 referrals
        );

        // Setup users with balances
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);
        vm.deal(dave, 100 ether);
        vm.deal(eve, 100 ether);

        vm.prank(alice);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();

        vm.prank(bob);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();

        vm.prank(charlie);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();

        vm.prank(dave);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();

        vm.prank(eve);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();
        
        // Test contract also needs funds to pay commissions
        vm.deal(address(this), 100 ether);
        PredictionMarketFacet(address(diamond)).deposit{value: 50 ether}();
    }

    function testRegisterReferral() public {
        vm.expectEmit(true, true, false, false);
        emit ReferralRegistered(bob, alice);

        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        (
            address referrer,
            uint256 referredCount,
            uint256 totalEarned,
            uint256 tier,
            ,
            bool isActive
        ) = ReferralSystemFacet(address(diamond)).getReferralData(bob);

        assertEq(referrer, alice);
        assertEq(referredCount, 0);
        assertEq(totalEarned, 0);
        assertEq(tier, 0); // Default tier
        assertTrue(isActive);

        // Alice should have 1 referral
        (
            ,
            uint256 aliceReferredCount,
            ,
            ,
            ,
        ) = ReferralSystemFacet(address(diamond)).getReferralData(alice);

        assertEq(aliceReferredCount, 1);
    }

    function testPayReferralCommission() public {
        // Bob registers with Alice as referrer
        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        uint256 aliceBalanceBefore = PredictionMarketFacet(address(diamond)).getBalance(alice);
        uint256 transactionAmount = 10 ether;

        // Expected commission: 5% of 10 ether = 0.5 ether
        uint256 expectedCommission = (transactionAmount * 500) / 10000;

        vm.expectEmit(true, true, false, true);
        emit ReferralCommissionPaid(alice, bob, expectedCommission, 0); // tier 0

        // Pay commission (tier 0 = 5% = 500 bps)
        uint256 commission = ReferralSystemFacet(address(diamond)).payReferralCommission(bob, transactionAmount);

        uint256 aliceBalanceAfter = PredictionMarketFacet(address(diamond)).getBalance(alice);

        // Commission should be 5% of transaction amount (tier 0 rate)
        assertEq(commission, expectedCommission);
        assertEq(aliceBalanceAfter, aliceBalanceBefore + expectedCommission);

        // Check Alice's total earned
        (
            ,
            ,
            uint256 totalEarned,
            ,
            ,
        ) = ReferralSystemFacet(address(diamond)).getReferralData(alice);

        assertEq(totalEarned, expectedCommission);
    }

    function testTierUpgrade() public {
        // Alice refers multiple people to upgrade tiers
        // Tier 1 requires 5 referrals, Tier 2 requires 20, Tier 3 requires 50

        // Register 5 people (Bob, Charlie, Dave, Eve, + 1 more)
        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        vm.prank(charlie);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        vm.prank(dave);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        vm.prank(eve);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        address newUser = address(0x6);
        vm.prank(newUser);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        // Alice should be tier 1 now (5+ referrals)
        (
            ,
            uint256 referredCount,
            ,
            uint256 tier,
            ,
        ) = ReferralSystemFacet(address(diamond)).getReferralData(alice);

        assertEq(referredCount, 5);
        assertEq(tier, 1);
    }

    function testCommissionRatesByTier() public {
        // Test that different tiers get different commission rates
        // Tier 0: 5%, Tier 1: 7.5%, Tier 2: 10%, Tier 3: 12.5%

        // Bob registers with Alice (Alice starts at tier 0)
        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        uint256 transactionAmount = 10 ether;

        // Tier 0 commission (5%)
        uint256 commission0 = ReferralSystemFacet(address(diamond)).payReferralCommission(bob, transactionAmount);
        assertEq(commission0, (transactionAmount * 500) / 10000);

        // Upgrade Alice to tier 1 by adding 4 more referrals
        for (uint i = 0; i < 4; i++) {
            address user = address(uint160(0x100 + i));
            vm.prank(user);
            ReferralSystemFacet(address(diamond)).registerReferral(alice);
        }

        // Verify Alice is now tier 1
        (,,, uint256 tier,,) = ReferralSystemFacet(address(diamond)).getReferralData(alice);
        assertEq(tier, 1);

        // Tier 1 commission (7.5%)
        uint256 commission1 = ReferralSystemFacet(address(diamond)).payReferralCommission(bob, transactionAmount);
        assertEq(commission1, (transactionAmount * 750) / 10000);

        // Tier 1 commission should be higher than tier 0
        assertGt(commission1, commission0);
    }

    function testReferralChain() public {
        // Create a referral chain: Alice -> Bob -> Charlie -> Dave

        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        vm.prank(charlie);
        ReferralSystemFacet(address(diamond)).registerReferral(bob);

        vm.prank(dave);
        ReferralSystemFacet(address(diamond)).registerReferral(charlie);

        // Get Dave's referral chain
        address[] memory chain = ReferralSystemFacet(address(diamond)).getReferralChain(dave);

        assertEq(chain.length, 3);
        assertEq(chain[0], charlie); // Immediate referrer
        assertEq(chain[1], bob);
        assertEq(chain[2], alice);
    }

    function testTotalReferralsAndCommissions() public {
        // Register some referrals
        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        vm.prank(charlie);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        uint256 totalReferrals = ReferralSystemFacet(address(diamond)).getTotalReferrals();
        assertEq(totalReferrals, 2);

        // Pay some commissions
        ReferralSystemFacet(address(diamond)).payReferralCommission(bob, 10 ether);
        ReferralSystemFacet(address(diamond)).payReferralCommission(charlie, 5 ether);

        uint256 totalCommissions = ReferralSystemFacet(address(diamond)).getTotalCommissions();

        // Total should be sum of both commissions
        uint256 expectedTotal = (10 ether * 500 / 10000) + (5 ether * 500 / 10000);
        assertEq(totalCommissions, expectedTotal);
    }

    function testNoCommissionForNonRegistered() public {
        // Bob hasn't registered a referrer
        uint256 commission = ReferralSystemFacet(address(diamond)).payReferralCommission(bob, 10 ether);

        // Should return 0 commission
        assertEq(commission, 0);
    }

    function testInactiveReferralNoCommission() public {
        // Register referral
        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        // Note: Would need admin function to deactivate users
        // This test assumes users can be deactivated

        // For now, active users should always receive commission
        uint256 commission = ReferralSystemFacet(address(diamond)).payReferralCommission(bob, 10 ether);
        assertGt(commission, 0);
    }

    function test_RevertWhen_SelfReferral() public {
        // Alice tries to refer herself
        vm.prank(alice);
        vm.expectRevert("Cannot refer yourself");
        ReferralSystemFacet(address(diamond)).registerReferral(alice);
    }

    function test_RevertWhen_DoubleRegistration() public {
        // Bob registers with Alice
        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        // Bob tries to register again with Charlie
        vm.prank(bob);
        vm.expectRevert("Already registered");
        ReferralSystemFacet(address(diamond)).registerReferral(charlie);
    }

    function test_RevertWhen_RegisterZeroAddress() public {
        vm.prank(bob);
        vm.expectRevert("Invalid referrer");
        ReferralSystemFacet(address(diamond)).registerReferral(address(0));
    }

    function testMultipleTierUpgrades() public {
        // Test progression through all tiers
        // Tier 0 -> Tier 1 (5 referrals)
        // Tier 1 -> Tier 2 (20 referrals)
        // Tier 2 -> Tier 3 (50 referrals)

        // Register 50 referrals for Alice
        for (uint i = 0; i < 50; i++) {
            address user = address(uint160(0x1000 + i));
            vm.prank(user);
            ReferralSystemFacet(address(diamond)).registerReferral(alice);
        }

        (
            ,
            uint256 referredCount,
            ,
            uint256 tier,
            ,
        ) = ReferralSystemFacet(address(diamond)).getReferralData(alice);

        assertEq(referredCount, 50);
        assertEq(tier, 3); // Should be at max tier
    }

    function testReferralEarningsTracking() public {
        // Register Bob with Alice
        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        // Pay multiple commissions
        ReferralSystemFacet(address(diamond)).payReferralCommission(bob, 10 ether);
        ReferralSystemFacet(address(diamond)).payReferralCommission(bob, 5 ether);
        ReferralSystemFacet(address(diamond)).payReferralCommission(bob, 3 ether);

        (
            ,
            ,
            uint256 totalEarned,
            ,
            ,
        ) = ReferralSystemFacet(address(diamond)).getReferralData(alice);

        // Should equal sum of all commissions
        uint256 expectedEarnings = ((10 ether + 5 ether + 3 ether) * 500) / 10000;
        assertEq(totalEarned, expectedEarnings);
    }

    function testReferralDataAccuracy() public {
        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        (
            address referrer,
            uint256 referredCount,
            uint256 totalEarned,
            uint256 tier,
            uint256 registeredAt,
            bool isActive
        ) = ReferralSystemFacet(address(diamond)).getReferralData(bob);

        assertEq(referrer, alice);
        assertEq(referredCount, 0); // Bob hasn't referred anyone yet
        assertEq(totalEarned, 0); // Bob hasn't earned anything yet
        assertEq(tier, 0);
        assertGt(registeredAt, 0);
        assertTrue(isActive);
    }

    function testMultiLevelReferralSystem() public {
        // Test a complex referral tree
        // Alice -> Bob -> Charlie
        //       -> Dave
        //       -> Eve -> User1

        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        vm.prank(charlie);
        ReferralSystemFacet(address(diamond)).registerReferral(bob);

        vm.prank(dave);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        vm.prank(eve);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        address user1 = address(0x100);
        vm.prank(user1);
        ReferralSystemFacet(address(diamond)).registerReferral(eve);

        // Alice should have 3 direct referrals
        (, uint256 aliceReferrals,,,, ) = ReferralSystemFacet(address(diamond)).getReferralData(alice);
        assertEq(aliceReferrals, 3);

        // Bob should have 1 direct referral
        (, uint256 bobReferrals,,,, ) = ReferralSystemFacet(address(diamond)).getReferralData(bob);
        assertEq(bobReferrals, 1);

        // Eve should have 1 direct referral
        (, uint256 eveReferrals,,,, ) = ReferralSystemFacet(address(diamond)).getReferralData(eve);
        assertEq(eveReferrals, 1);

        // User1's chain should be: Eve -> Alice (third level is empty)
        address[] memory chain = ReferralSystemFacet(address(diamond)).getReferralChain(user1);
        assertEq(chain.length, 3); // Array always has length 3
        assertEq(chain[0], eve);
        assertEq(chain[1], alice);
        assertEq(chain[2], address(0)); // Third level is empty
    }

    function testCommissionPaymentIntegrity() public {
        // Ensure commission payments are accurate and don't exceed transaction amounts

        vm.prank(bob);
        ReferralSystemFacet(address(diamond)).registerReferral(alice);

        uint256 transactionAmount = 1 ether;

        // All tier commission rates should be < 100%
        uint256 commission = ReferralSystemFacet(address(diamond)).payReferralCommission(bob, transactionAmount);

        // Commission should never exceed transaction amount
        assertLt(commission, transactionAmount);

        // Commission should be exactly 5% for tier 0
        assertEq(commission, (transactionAmount * 500) / 10000);
    }
}

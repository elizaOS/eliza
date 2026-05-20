// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Script.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/LiquidityPoolFacet.sol";
import "../core/PerpetualMarketFacet.sol";
import "../core/ReferralSystemFacet.sol";
import "../libraries/LibDiamond.sol";
import "../interfaces/IDiamondLoupe.sol";

/// @title UpgradeDiamond
/// @notice Upgrade script to add new facets to existing Diamond deployment
/// @dev Adds LiquidityPoolFacet, PerpetualMarketFacet, and ReferralSystemFacet
contract UpgradeDiamond is Script {
    // Existing Diamond address (from deployment)
    address public diamondAddress;

    // New facets to deploy
    LiquidityPoolFacet public liquidityPoolFacet;
    PerpetualMarketFacet public perpetualMarketFacet;
    ReferralSystemFacet public referralSystemFacet;

    // Deployer
    address public deployer;

    function run() external {
        // Get deployer from private key
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(deployerPrivateKey);

        // Get existing Diamond address from environment or use default
        diamondAddress = vm.envOr("DIAMOND_ADDRESS", address(0));
        require(diamondAddress != address(0), "DIAMOND_ADDRESS not set in environment");

        console.log("Upgrading Diamond with new facets...");
        console.log("Diamond Address:", diamondAddress);
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy new facets
        console.log("\n1. Deploying new facets...");
        liquidityPoolFacet = new LiquidityPoolFacet();
        console.log("LiquidityPoolFacet:", address(liquidityPoolFacet));

        perpetualMarketFacet = new PerpetualMarketFacet();
        console.log("PerpetualMarketFacet:", address(perpetualMarketFacet));

        referralSystemFacet = new ReferralSystemFacet();
        console.log("ReferralSystemFacet:", address(referralSystemFacet));

        // 2. Prepare facet cuts
        console.log("\n2. Preparing facet cuts...");
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);

        // 2a. LiquidityPoolFacet selectors
        bytes4[] memory liquiditySelectors = new bytes4[](14);
        liquiditySelectors[0] = LiquidityPoolFacet.createLiquidityPool.selector;
        liquiditySelectors[1] = LiquidityPoolFacet.addLiquidity.selector;
        liquiditySelectors[2] = LiquidityPoolFacet.removeLiquidity.selector;
        liquiditySelectors[3] = LiquidityPoolFacet.swap.selector;
        liquiditySelectors[4] = LiquidityPoolFacet.setPoolActive.selector;
        liquiditySelectors[5] = LiquidityPoolFacet.claimRewards.selector;
        liquiditySelectors[6] = LiquidityPoolFacet.getPool.selector;
        liquiditySelectors[7] = LiquidityPoolFacet.getLPPosition.selector;
        liquiditySelectors[8] = LiquidityPoolFacet.getReserves.selector;
        liquiditySelectors[9] = LiquidityPoolFacet.getSwapOutput.selector;
        liquiditySelectors[10] = LiquidityPoolFacet.getPriceImpact.selector;
        liquiditySelectors[11] = LiquidityPoolFacet.getUtilization.selector;
        liquiditySelectors[12] = LiquidityPoolFacet.getImpermanentLoss.selector;
        liquiditySelectors[13] = LiquidityPoolFacet.getPendingRewards.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(liquidityPoolFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: liquiditySelectors
        });
        console.log("LiquidityPoolFacet: %d selectors", liquiditySelectors.length);

        // 2b. PerpetualMarketFacet selectors
        bytes4[] memory perpetualSelectors = new bytes4[](10);
        perpetualSelectors[0] = PerpetualMarketFacet.createPerpetualMarket.selector;
        perpetualSelectors[1] = PerpetualMarketFacet.openPosition.selector;
        perpetualSelectors[2] = PerpetualMarketFacet.closePosition.selector;
        perpetualSelectors[3] = PerpetualMarketFacet.liquidatePosition.selector;
        perpetualSelectors[4] = PerpetualMarketFacet.updateFundingRate.selector;
        perpetualSelectors[5] = PerpetualMarketFacet.getPerpetualMarket.selector;
        perpetualSelectors[6] = PerpetualMarketFacet.getPosition.selector;
        perpetualSelectors[7] = PerpetualMarketFacet.getLiquidationPrice.selector;
        perpetualSelectors[8] = PerpetualMarketFacet.getMarkPrice.selector;
        perpetualSelectors[9] = PerpetualMarketFacet.getFundingRate.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(perpetualMarketFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: perpetualSelectors
        });
        console.log("PerpetualMarketFacet: %d selectors", perpetualSelectors.length);

        // 2c. ReferralSystemFacet selectors
        bytes4[] memory referralSelectors = new bytes4[](12);
        referralSelectors[0] = ReferralSystemFacet.registerReferral.selector;
        referralSelectors[1] = ReferralSystemFacet.payReferralCommission.selector;
        referralSelectors[2] = ReferralSystemFacet.claimReferralEarnings.selector;
        referralSelectors[3] = ReferralSystemFacet.initializeReferralSystem.selector;
        referralSelectors[4] = ReferralSystemFacet.getReferralData.selector;
        referralSelectors[5] = ReferralSystemFacet.getTierInfo.selector;
        referralSelectors[6] = ReferralSystemFacet.getReferralChain.selector;
        referralSelectors[7] = ReferralSystemFacet.getTotalStats.selector;
        referralSelectors[8] = ReferralSystemFacet.getTotalReferrals.selector;
        referralSelectors[9] = ReferralSystemFacet.getTotalCommissions.selector;
        referralSelectors[10] = ReferralSystemFacet.isReferred.selector;
        referralSelectors[11] = ReferralSystemFacet.calculateCommission.selector;

        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(referralSystemFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: referralSelectors
        });
        console.log("ReferralSystemFacet: %d selectors", referralSelectors.length);

        // 3. Execute diamond cut
        console.log("\n3. Executing diamond cut...");
        IDiamondCut(diamondAddress).diamondCut(cuts, address(0), "");
        console.log("Diamond cut successful!");

        vm.stopBroadcast();

        // 4. Verify upgrade
        console.log("\n4. Verifying upgrade...");
        IDiamondLoupe loupe = IDiamondLoupe(diamondAddress);
        address[] memory facetAddresses = loupe.facetAddresses();
        console.log("Total facets after upgrade:", facetAddresses.length);

        // Print all facets
        console.log("\nAll facets:");
        for (uint i = 0; i < facetAddresses.length; i++) {
            bytes4[] memory selectors = loupe.facetFunctionSelectors(facetAddresses[i]);
            console.log("  Facet %d: %s (%d functions)", i, facetAddresses[i], selectors.length);
        }

        // Print upgrade summary
        console.log("\n=== Upgrade Summary ===");
        console.log("Diamond:", diamondAddress);
        console.log("LiquidityPoolFacet:", address(liquidityPoolFacet));
        console.log("PerpetualMarketFacet:", address(perpetualMarketFacet));
        console.log("ReferralSystemFacet:", address(referralSystemFacet));
        console.log("\nUpgrade completed successfully!");
        console.log("The Diamond now has access to:");
        console.log("  - Liquidity pools with AMM pricing");
        console.log("  - Perpetual futures with funding rates");
        console.log("  - Multi-tier referral system");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Script.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../core/OracleFacet.sol";
import "../core/GameOracleFacet.sol";
import "../core/LiquidityPoolFacet.sol";
import "../core/PerpetualMarketFacet.sol";
import "../core/ReferralSystemFacet.sol";
import "../core/PriceStorageFacet.sol";
import "../identity/ERC8004IdentityRegistry.sol";
import "../identity/ERC8004ReputationSystem.sol";
import "../oracles/ChainlinkOracleMock.sol";
import "../oracles/MockOracle.sol";
import "../libraries/LibDiamond.sol";

// Oracle system - Game as Prediction Oracle
import {PolyagentGameOracle} from "../src/game/PolyagentGameOracle.sol";
import {BanManager} from "../src/moderation/BanManager.sol";

/// @title DeployPolyagent
/// @notice Deployment script for Polyagent prediction market on Base L2
/// @dev Consolidated architecture: Diamond + PolyagentGameOracle
/// 
/// Architecture:
/// - Diamond: PredictionMarketFacet handles LMSR trading
/// - PolyagentGameOracle: IPredictionOracle interface for game outcomes
/// - GameOracleFacet: Bridges oracle outcomes to Diamond markets
/// 
/// Flow:
/// 1. Game engine commits/reveals outcomes to PolyagentGameOracle
/// 2. PolyagentGameOracle stores outcomes on-chain
/// 3. GameOracleFacet reads outcomes and resolves Diamond markets
/// 4. External contracts can query PolyagentGameOracle directly
contract DeployPolyagent is Script {
    // Deployed contracts - Diamond system
    Diamond public diamond;
    DiamondCutFacet public diamondCutFacet;
    DiamondLoupeFacet public diamondLoupeFacet;
    PredictionMarketFacet public predictionMarketFacet;
    OracleFacet public oracleFacet;
    GameOracleFacet public gameOracleFacet;
    LiquidityPoolFacet public liquidityPoolFacet;
    PerpetualMarketFacet public perpetualMarketFacet;
    ReferralSystemFacet public referralSystemFacet;
    PriceStorageFacet public priceStorageFacet;
    
    // Identity system
    ERC8004IdentityRegistry public identityRegistry;
    ERC8004ReputationSystem public reputationSystem;
    
    // Oracle mocks
    ChainlinkOracleMock public chainlinkOracle;
    MockOracle public mockOracle;
    
    // Game Oracle - The game IS the prediction oracle
    PolyagentGameOracle public polyagentOracle;
    
    // Moderation
    BanManager public banManager;

    // Deployment configuration
    address public deployer;
    address public feeRecipient;

    function run() external {
        // Get deployer from private key
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(deployerPrivateKey);

        // Set fee recipient (can be changed later)
        feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);

        console.log("Deploying Polyagent to Base L2...");
        console.log("Deployer:", deployer);
        console.log("Fee Recipient:", feeRecipient);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy facets
        console.log("\n1. Deploying facets...");
        diamondCutFacet = new DiamondCutFacet();
        console.log("DiamondCutFacet:", address(diamondCutFacet));

        diamondLoupeFacet = new DiamondLoupeFacet();
        console.log("DiamondLoupeFacet:", address(diamondLoupeFacet));

        predictionMarketFacet = new PredictionMarketFacet();
        console.log("PredictionMarketFacet:", address(predictionMarketFacet));

        oracleFacet = new OracleFacet();
        console.log("OracleFacet:", address(oracleFacet));
        
        gameOracleFacet = new GameOracleFacet();
        console.log("GameOracleFacet:", address(gameOracleFacet));

        // 2. Deploy Diamond with DiamondCutFacet
        console.log("\n2. Deploying Diamond...");
        diamond = new Diamond(address(diamondCutFacet), address(diamondLoupeFacet));
        console.log("Diamond:", address(diamond));

        // 3. Add DiamondLoupeFacet
        console.log("\n3. Adding DiamondLoupeFacet...");
        IDiamondCut.FacetCut[] memory loupeCut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory loupeSelectors = new bytes4[](5);
        loupeSelectors[0] = DiamondLoupeFacet.facets.selector;
        loupeSelectors[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSelectors[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSelectors[3] = DiamondLoupeFacet.facetAddress.selector;
        loupeSelectors[4] = bytes4(keccak256("supportsInterface(bytes4)"));

        loupeCut[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: loupeSelectors
        });

        IDiamondCut(address(diamond)).diamondCut(loupeCut, address(0), "");

        // 4. Add PredictionMarketFacet
        console.log("\n4. Adding PredictionMarketFacet...");
        IDiamondCut.FacetCut[] memory marketCut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory marketSelectors = new bytes4[](14);
        marketSelectors[0] = PredictionMarketFacet.createMarket.selector;
        marketSelectors[1] = PredictionMarketFacet.calculateCost.selector;
        marketSelectors[2] = PredictionMarketFacet.calculateCostWithFee.selector;
        marketSelectors[3] = PredictionMarketFacet.buyShares.selector;
        marketSelectors[4] = PredictionMarketFacet.sellShares.selector;
        marketSelectors[5] = PredictionMarketFacet.calculateSellPayout.selector;
        marketSelectors[6] = PredictionMarketFacet.resolveMarket.selector;
        marketSelectors[7] = PredictionMarketFacet.claimWinnings.selector;
        marketSelectors[8] = PredictionMarketFacet.deposit.selector;
        marketSelectors[9] = PredictionMarketFacet.withdraw.selector;
        marketSelectors[10] = PredictionMarketFacet.getBalance.selector;
        marketSelectors[11] = PredictionMarketFacet.getMarket.selector;
        marketSelectors[12] = PredictionMarketFacet.getMarketShares.selector;
        marketSelectors[13] = PredictionMarketFacet.getPosition.selector;

        marketCut[0] = IDiamondCut.FacetCut({
            facetAddress: address(predictionMarketFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: marketSelectors
        });

        IDiamondCut(address(diamond)).diamondCut(marketCut, address(0), "");

        // 5. Add OracleFacet
        console.log("\n5. Adding OracleFacet...");
        IDiamondCut.FacetCut[] memory oracleCut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory oracleSelectors = new bytes4[](8);
        oracleSelectors[0] = OracleFacet.requestChainlinkResolution.selector;
        oracleSelectors[1] = OracleFacet.requestMockResolution.selector;
        oracleSelectors[2] = OracleFacet.oracleCallback.selector;
        oracleSelectors[3] = OracleFacet.mockOracleCallback.selector;
        oracleSelectors[4] = OracleFacet.setChainlinkOracle.selector;
        oracleSelectors[5] = OracleFacet.setMockOracle.selector;
        oracleSelectors[6] = OracleFacet.manualResolve.selector;
        oracleSelectors[7] = OracleFacet.getOracleAddresses.selector;

        oracleCut[0] = IDiamondCut.FacetCut({
            facetAddress: address(oracleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: oracleSelectors
        });

        IDiamondCut(address(diamond)).diamondCut(oracleCut, address(0), "");
        
        // 5b. Add GameOracleFacet
        console.log("\n5b. Adding GameOracleFacet...");
        IDiamondCut.FacetCut[] memory gameOracleCut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory gameOracleSelectors = new bytes4[](9);
        gameOracleSelectors[0] = GameOracleFacet.setGameOracle.selector;
        gameOracleSelectors[1] = GameOracleFacet.getGameOracle.selector;
        gameOracleSelectors[2] = GameOracleFacet.linkMarketToSession.selector;
        gameOracleSelectors[3] = GameOracleFacet.getSessionForMarket.selector;
        gameOracleSelectors[4] = GameOracleFacet.getMarketForSession.selector;
        gameOracleSelectors[5] = GameOracleFacet.resolveFromGameOracle.selector;
        gameOracleSelectors[6] = GameOracleFacet.queryOracleOutcome.selector;
        gameOracleSelectors[7] = GameOracleFacet.isWinnerInSession.selector;
        gameOracleSelectors[8] = GameOracleFacet.createMarketForSession.selector;

        gameOracleCut[0] = IDiamondCut.FacetCut({
            facetAddress: address(gameOracleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: gameOracleSelectors
        });

        IDiamondCut(address(diamond)).diamondCut(gameOracleCut, address(0), "");

        // 6. Deploy and add new facets (LiquidityPool, PerpetualMarket, ReferralSystem)
        console.log("\n6. Deploying new facets...");
        liquidityPoolFacet = new LiquidityPoolFacet();
        console.log("LiquidityPoolFacet:", address(liquidityPoolFacet));

        perpetualMarketFacet = new PerpetualMarketFacet();
        console.log("PerpetualMarketFacet:", address(perpetualMarketFacet));

        referralSystemFacet = new ReferralSystemFacet();
        console.log("ReferralSystemFacet:", address(referralSystemFacet));

        priceStorageFacet = new PriceStorageFacet();
        console.log("PriceStorageFacet:", address(priceStorageFacet));

        // 7. Add new facets to Diamond
        console.log("\n7. Adding new facets to Diamond...");
        IDiamondCut.FacetCut[] memory newFacetsCut = new IDiamondCut.FacetCut[](4);

        // LiquidityPoolFacet selectors
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

        newFacetsCut[0] = IDiamondCut.FacetCut({
            facetAddress: address(liquidityPoolFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: liquiditySelectors
        });

        // PerpetualMarketFacet selectors
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

        newFacetsCut[1] = IDiamondCut.FacetCut({
            facetAddress: address(perpetualMarketFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: perpetualSelectors
        });

        // ReferralSystemFacet selectors
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

        newFacetsCut[2] = IDiamondCut.FacetCut({
            facetAddress: address(referralSystemFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: referralSelectors
        });

        // PriceStorageFacet selectors
        bytes4[] memory priceSelectors = new bytes4[](9);
        priceSelectors[0] = PriceStorageFacet.updatePrices.selector;
        priceSelectors[1] = PriceStorageFacet.updatePrice.selector;
        priceSelectors[2] = PriceStorageFacet.submitPriceBatch.selector;
        priceSelectors[3] = PriceStorageFacet.getLatestPrice.selector;
        priceSelectors[4] = PriceStorageFacet.getPriceAtTick.selector;
        priceSelectors[5] = PriceStorageFacet.getGlobalTickCounter.selector;
        priceSelectors[6] = PriceStorageFacet.incrementTickCounter.selector;
        priceSelectors[7] = PriceStorageFacet.setAuthorizedUpdater.selector;
        priceSelectors[8] = PriceStorageFacet.getAuthorizedUpdater.selector;

        newFacetsCut[3] = IDiamondCut.FacetCut({
            facetAddress: address(priceStorageFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: priceSelectors
        });

        IDiamondCut(address(diamond)).diamondCut(newFacetsCut, address(0), "");

        // 8. Deploy ERC-8004 Identity Registry
        console.log("\n8. Deploying ERC-8004 Identity Registry...");
        identityRegistry = new ERC8004IdentityRegistry();
        console.log("IdentityRegistry:", address(identityRegistry));

        // 9. Deploy ERC-8004 Reputation System
        console.log("\n9. Deploying ERC-8004 Reputation System...");
        reputationSystem = new ERC8004ReputationSystem(address(identityRegistry));
        console.log("ReputationSystem:", address(reputationSystem));

        // 10. Deploy Oracle Mocks (for testnet)
        if (block.chainid == 84532 || block.chainid == 31337) { // Base Sepolia or Localnet
            console.log("\n10. Deploying Oracle Mocks (Testnet)...");
            chainlinkOracle = new ChainlinkOracleMock();
            console.log("ChainlinkOracle:", address(chainlinkOracle));

            mockOracle = new MockOracle();
            console.log("MockOracle:", address(mockOracle));

            // Set oracle addresses in diamond
            OracleFacet(address(diamond)).setChainlinkOracle(address(chainlinkOracle));
            OracleFacet(address(diamond)).setMockOracle(address(mockOracle));
        } else {
            console.log("\n10. Skipping Oracle Mocks (Mainnet - use real oracles)");
        }
        
        // 11. Deploy Polyagent Game Oracle - THE GAME IS THE PREDICTION ORACLE
        console.log("\n11. Deploying Polyagent Game Oracle (IPredictionOracle)...");
        polyagentOracle = new PolyagentGameOracle(deployer); // Deployer is game server initially
        console.log("PolyagentGameOracle:", address(polyagentOracle));
        
        // 12. Configure GameOracleFacet to use PolyagentGameOracle
        console.log("\n12. Configuring GameOracleFacet...");
        GameOracleFacet(address(diamond)).setGameOracle(address(polyagentOracle));
        console.log("GameOracle set in Diamond");
        
        // 13. Deploy BanManager (standalone moderation)
        console.log("\n13. Deploying BanManager...");
        banManager = new BanManager(deployer, deployer); // governance, owner
        console.log("BanManager:", address(banManager));

        vm.stopBroadcast();

        // Print deployment summary
        console.log("\n=================== DEPLOYMENT SUMMARY ===================");
        console.log("\n--- Diamond System ---");
        console.log("Diamond (Proxy):", address(diamond));
        console.log("DiamondCutFacet:", address(diamondCutFacet));
        console.log("DiamondLoupeFacet:", address(diamondLoupeFacet));
        console.log("PredictionMarketFacet:", address(predictionMarketFacet));
        console.log("OracleFacet:", address(oracleFacet));
        console.log("GameOracleFacet:", address(gameOracleFacet));
        console.log("LiquidityPoolFacet:", address(liquidityPoolFacet));
        console.log("PerpetualMarketFacet:", address(perpetualMarketFacet));
        console.log("ReferralSystemFacet:", address(referralSystemFacet));
        console.log("PriceStorageFacet:", address(priceStorageFacet));
        
        console.log("\n--- Identity System ---");
        console.log("IdentityRegistry:", address(identityRegistry));
        console.log("ReputationSystem:", address(reputationSystem));
        
        console.log("\n--- Game Oracle (IPredictionOracle) ---");
        console.log("PolyagentGameOracle:", address(polyagentOracle));
        console.log("  -> External contracts query: oracle.getOutcome(sessionId)");
        console.log("  -> Diamond resolves via: GameOracleFacet.resolveFromGameOracle()");
        
        console.log("\n--- Moderation ---");
        console.log("BanManager:", address(banManager));
        
        if (block.chainid == 84532 || block.chainid == 31337) {
            console.log("\n--- Test Infrastructure ---");
            console.log("ChainlinkOracle (Mock):", address(chainlinkOracle));
            console.log("MockOracle:", address(mockOracle));
        }
        
        console.log("\n==========================================================");
    }
}

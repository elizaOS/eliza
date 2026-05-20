// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../core/OracleFacet.sol";
import "../core/LiquidityPoolFacet.sol";
import "../core/PerpetualMarketFacet.sol";
import "../core/ReferralSystemFacet.sol";
import "../core/PriceStorageFacet.sol";
import "../core/GameOracleFacet.sol";
import "../libraries/LibDiamond.sol";
import "../oracles/ChainlinkOracleMock.sol";
import "../oracles/MockOracle.sol";

/// @title DiamondTestSetup
/// @notice Base test contract with Diamond deployment and facet setup
contract DiamondTestSetup is Test {
    Diamond public diamond;
    DiamondCutFacet public diamondCutFacet;
    DiamondLoupeFacet public diamondLoupeFacet;
    PredictionMarketFacet public predictionMarketFacet;
    OracleFacet public oracleFacet;
    LiquidityPoolFacet public liquidityPoolFacet;
    PerpetualMarketFacet public perpetualMarketFacet;
    ReferralSystemFacet public referralSystemFacet;
    PriceStorageFacet public priceStorageFacet;
    GameOracleFacet public gameOracleFacet;
    ChainlinkOracleMock public chainlinkOracle;
    MockOracle public mockOracle;

    address public owner;
    address public user1;
    address public user2;
    address public user3;

    function setUp() public virtual {
        // Setup test accounts
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");
        user3 = makeAddr("user3");

        // Fund test accounts
        vm.deal(user1, 100 ether);
        vm.deal(user2, 100 ether);
        vm.deal(user3, 100 ether);

        // Deploy facets
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        predictionMarketFacet = new PredictionMarketFacet();
        oracleFacet = new OracleFacet();
        liquidityPoolFacet = new LiquidityPoolFacet();
        perpetualMarketFacet = new PerpetualMarketFacet();
        referralSystemFacet = new ReferralSystemFacet();
        priceStorageFacet = new PriceStorageFacet();
        gameOracleFacet = new GameOracleFacet();

        // Deploy Diamond with DiamondCutFacet and DiamondLoupeFacet
        diamond = new Diamond(address(diamondCutFacet), address(diamondLoupeFacet));

        // Add DiamondLoupeFacet
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

        // Add PredictionMarketFacet
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

        // Add OracleFacet
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

        // Add LiquidityPoolFacet
        _addLiquidityPoolFacet();

        // Add PerpetualMarketFacet
        _addPerpetualMarketFacet();

        // Add ReferralSystemFacet
        _addReferralSystemFacet();

        // Add PriceStorageFacet
        _addPriceStorageFacet();

        // Add GameOracleFacet
        _addGameOracleFacet();

        // Deploy oracles
        chainlinkOracle = new ChainlinkOracleMock();
        mockOracle = new MockOracle();

        // Set oracle addresses in diamond
        OracleFacet(address(diamond)).setChainlinkOracle(address(chainlinkOracle));
        OracleFacet(address(diamond)).setMockOracle(address(mockOracle));
    }

    function _addLiquidityPoolFacet() internal {
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = LiquidityPoolFacet.createLiquidityPool.selector;
        selectors[1] = LiquidityPoolFacet.addLiquidity.selector;
        selectors[2] = LiquidityPoolFacet.removeLiquidity.selector;
        selectors[3] = LiquidityPoolFacet.swap.selector;
        selectors[4] = LiquidityPoolFacet.setPoolActive.selector;
        selectors[5] = LiquidityPoolFacet.claimRewards.selector;
        selectors[6] = LiquidityPoolFacet.getPool.selector;
        selectors[7] = LiquidityPoolFacet.getLPPosition.selector;
        selectors[8] = LiquidityPoolFacet.getReserves.selector;
        selectors[9] = LiquidityPoolFacet.getSwapOutput.selector;
        selectors[10] = LiquidityPoolFacet.getPriceImpact.selector;
        selectors[11] = LiquidityPoolFacet.getUtilization.selector;
        selectors[12] = LiquidityPoolFacet.getImpermanentLoss.selector;
        selectors[13] = LiquidityPoolFacet.getPendingRewards.selector;

        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(liquidityPoolFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });

        IDiamondCut(address(diamond)).diamondCut(cut, address(0), "");
    }

    function _addPerpetualMarketFacet() internal {
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = PerpetualMarketFacet.createPerpetualMarket.selector;
        selectors[1] = PerpetualMarketFacet.openPosition.selector;
        selectors[2] = PerpetualMarketFacet.closePosition.selector;
        selectors[3] = PerpetualMarketFacet.liquidatePosition.selector;
        selectors[4] = PerpetualMarketFacet.updateFundingRate.selector;
        selectors[5] = PerpetualMarketFacet.getPerpetualMarket.selector;
        selectors[6] = PerpetualMarketFacet.getPosition.selector;
        selectors[7] = PerpetualMarketFacet.getLiquidationPrice.selector;
        selectors[8] = PerpetualMarketFacet.getMarkPrice.selector;
        selectors[9] = PerpetualMarketFacet.getFundingRate.selector;

        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(perpetualMarketFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });

        IDiamondCut(address(diamond)).diamondCut(cut, address(0), "");
    }

    function _addReferralSystemFacet() internal {
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = ReferralSystemFacet.registerReferral.selector;
        selectors[1] = ReferralSystemFacet.payReferralCommission.selector;
        selectors[2] = ReferralSystemFacet.claimReferralEarnings.selector;
        selectors[3] = ReferralSystemFacet.initializeReferralSystem.selector;
        selectors[4] = ReferralSystemFacet.getReferralData.selector;
        selectors[5] = ReferralSystemFacet.getTierInfo.selector;
        selectors[6] = ReferralSystemFacet.getReferralChain.selector;
        selectors[7] = ReferralSystemFacet.getTotalStats.selector;
        selectors[8] = ReferralSystemFacet.getTotalReferrals.selector;
        selectors[9] = ReferralSystemFacet.getTotalCommissions.selector;
        selectors[10] = ReferralSystemFacet.isReferred.selector;
        selectors[11] = ReferralSystemFacet.calculateCommission.selector;

        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(referralSystemFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });

        IDiamondCut(address(diamond)).diamondCut(cut, address(0), "");
    }

    function _addPriceStorageFacet() internal {
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = PriceStorageFacet.updatePrices.selector;
        selectors[1] = PriceStorageFacet.updatePrice.selector;
        selectors[2] = PriceStorageFacet.submitPriceBatch.selector;
        selectors[3] = PriceStorageFacet.getLatestPrice.selector;
        selectors[4] = PriceStorageFacet.getPriceAtTick.selector;
        selectors[5] = PriceStorageFacet.getGlobalTickCounter.selector;
        selectors[6] = PriceStorageFacet.incrementTickCounter.selector;
        selectors[7] = PriceStorageFacet.setAuthorizedUpdater.selector;
        selectors[8] = PriceStorageFacet.getAuthorizedUpdater.selector;

        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(priceStorageFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });

        IDiamondCut(address(diamond)).diamondCut(cut, address(0), "");
    }

    function _addGameOracleFacet() internal {
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = GameOracleFacet.setGameOracle.selector;
        selectors[1] = GameOracleFacet.getGameOracle.selector;
        selectors[2] = GameOracleFacet.linkMarketToSession.selector;
        selectors[3] = GameOracleFacet.getSessionForMarket.selector;
        selectors[4] = GameOracleFacet.getMarketForSession.selector;
        selectors[5] = GameOracleFacet.resolveFromGameOracle.selector;
        selectors[6] = GameOracleFacet.queryOracleOutcome.selector;
        selectors[7] = GameOracleFacet.isWinnerInSession.selector;
        selectors[8] = GameOracleFacet.createMarketForSession.selector;

        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(gameOracleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });

        IDiamondCut(address(diamond)).diamondCut(cut, address(0), "");
    }

    /// @notice Helper to create a basic binary market
    function createBasicMarket() internal returns (bytes32 marketId) {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";

        marketId = PredictionMarketFacet(address(diamond)).createMarket(
            "Will ETH reach $5000 by EOY?",
            outcomes,
            block.timestamp + 30 days,
            owner
        );
    }
}

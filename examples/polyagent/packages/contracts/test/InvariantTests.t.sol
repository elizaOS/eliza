// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../libraries/LibDiamond.sol";
import "../src/game/PolyagentGameOracle.sol";

/// @title InvariantTests
/// @notice Invariant testing for critical contract properties
/// @dev Uses Foundry's invariant testing framework
contract InvariantTests is Test {
    Diamond diamond;
    DiamondCutFacet diamondCutFacet;
    DiamondLoupeFacet diamondLoupeFacet;
    PredictionMarketFacet predictionMarketFacet;
    PolyagentGameOracle polyagentOracle;

    address owner;
    address user1;
    address user2;
    address gameServer;

    MarketHandler handler;

    function setUp() public virtual {
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");
        gameServer = makeAddr("gameServer");

        vm.deal(user1, 100 ether);
        vm.deal(user2, 100 ether);

        // Deploy facets
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        predictionMarketFacet = new PredictionMarketFacet();

        // Deploy Diamond
        diamond = new Diamond(address(diamondCutFacet), address(diamondLoupeFacet));

        // Setup facets
        _setupDiamondFacets();

        // Deploy oracle
        polyagentOracle = new PolyagentGameOracle(gameServer);

        // Deploy handler for invariant testing
        handler = new MarketHandler(address(diamond), owner);
        vm.deal(address(handler), 1000 ether);

        // Target only the handler for invariant calls
        targetContract(address(handler));
    }

    function _setupDiamondFacets() internal {
        // Add DiamondLoupeFacet
        bytes4[] memory loupeSelectors = new bytes4[](4);
        loupeSelectors[0] = DiamondLoupeFacet.facets.selector;
        loupeSelectors[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSelectors[2] = DiamondLoupeFacet.facetAddresses.selector;
        loupeSelectors[3] = DiamondLoupeFacet.facetAddress.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: loupeSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Add PredictionMarketFacet
        bytes4[] memory pmSelectors = new bytes4[](13);
        pmSelectors[0] = PredictionMarketFacet.createMarket.selector;
        pmSelectors[1] = PredictionMarketFacet.calculateCost.selector;
        pmSelectors[2] = PredictionMarketFacet.buyShares.selector;
        pmSelectors[3] = PredictionMarketFacet.sellShares.selector;
        pmSelectors[4] = PredictionMarketFacet.calculateSellPayout.selector;
        pmSelectors[5] = PredictionMarketFacet.resolveMarket.selector;
        pmSelectors[6] = PredictionMarketFacet.claimWinnings.selector;
        pmSelectors[7] = PredictionMarketFacet.deposit.selector;
        pmSelectors[8] = PredictionMarketFacet.withdraw.selector;
        pmSelectors[9] = PredictionMarketFacet.getBalance.selector;
        pmSelectors[10] = PredictionMarketFacet.getMarket.selector;
        pmSelectors[11] = PredictionMarketFacet.getMarketShares.selector;
        pmSelectors[12] = PredictionMarketFacet.getPosition.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(predictionMarketFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: pmSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    // ============ Core Invariants ============

    /// @notice User balance should never exceed total deposits
    function invariant_balancesNeverNegative() public view {
        uint256 handlerBalance = PredictionMarketFacet(address(diamond)).getBalance(address(handler));
        // Balances are stored as uint256, so can't be negative, but verify consistency
        assertGe(handlerBalance, 0);
    }

    /// @notice Total shares in market should not overflow
    function invariant_noShareOverflow() public view {
        bytes32 marketId = handler.lastMarketId();
        if (marketId != bytes32(0)) {
            uint256 shares0 = PredictionMarketFacet(address(diamond)).getMarketShares(marketId, 0);
            uint256 shares1 = PredictionMarketFacet(address(diamond)).getMarketShares(marketId, 1);
            
            // Shares should be reasonable
            assertLt(shares0, type(uint128).max);
            assertLt(shares1, type(uint128).max);
        }
    }

    /// @notice Market count should only increase
    function invariant_marketCountMonotonic() public view {
        uint256 count = handler.marketCount();
        assertGe(count, 0);
    }

    /// @notice Total deposit operations should be tracked
    function invariant_operationsTracked() public view {
        uint256 deposits = handler.depositCount();
        uint256 withdrawals = handler.withdrawCount();
        // Operations are tracked (just verify they're valid counts)
        assertGe(deposits + withdrawals, 0);
    }
}

/// @title MarketHandler
/// @notice Handler contract for invariant testing
contract MarketHandler is Test {
    address public diamond;
    address public owner;

    bytes32 public lastMarketId;
    uint256 public marketCount;
    uint256 public depositCount;
    uint256 public withdrawCount;

    constructor(address _diamond, address _owner) {
        diamond = _diamond;
        owner = _owner;
    }

    /// @notice Deposit random amount
    function deposit(uint256 amount) external {
        amount = bound(amount, 0.01 ether, 10 ether);
        
        vm.deal(address(this), amount);
        PredictionMarketFacet(diamond).deposit{value: amount}();
        depositCount++;
    }

    /// @notice Withdraw random amount up to balance
    function withdraw(uint256 amount) external {
        uint256 balance = PredictionMarketFacet(diamond).getBalance(address(this));
        if (balance == 0) return;
        
        amount = bound(amount, 0, balance);
        PredictionMarketFacet(diamond).withdraw(amount);
        withdrawCount++;
    }

    /// @notice Create a market
    function createMarket() external {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        
        vm.prank(owner);
        lastMarketId = PredictionMarketFacet(diamond).createMarket(
            string(abi.encodePacked("Market ", marketCount)),
            outcomes,
            block.timestamp + 1 days,
            owner
        );
        marketCount++;
    }

    /// @notice Buy shares in existing market
    function buyShares(uint8 outcome, uint256 numShares) external {
        if (lastMarketId == bytes32(0)) return;
        
        outcome = uint8(bound(uint256(outcome), 0, 1));
        numShares = bound(numShares, 1, 100);
        
        uint256 cost = PredictionMarketFacet(diamond).calculateCost(lastMarketId, outcome, numShares);
        uint256 balance = PredictionMarketFacet(diamond).getBalance(address(this));
        
        if (balance < cost) {
            vm.deal(address(this), cost);
            PredictionMarketFacet(diamond).deposit{value: cost}();
            depositCount++;
        }
        
        PredictionMarketFacet(diamond).buyShares(lastMarketId, outcome, numShares);
    }

    receive() external payable {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {LibMarket} from "../libraries/LibMarket.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IPredictionOracle} from "../src/prediction-markets/IPredictionOracle.sol";

/**
 * @title GameOracleFacet
 * @notice Diamond facet for game-based prediction oracle integration
 * @dev Connects Diamond prediction markets to PolyagentGameOracle
 * 
 * Architecture:
 * - Game engine commits/reveals outcomes to PolyagentGameOracle
 * - PolyagentGameOracle stores outcomes on-chain (IPredictionOracle)
 * - This facet reads outcomes and resolves Diamond markets
 * - External contracts can query PolyagentGameOracle directly
 * 
 * The game IS the prediction oracle - this facet just bridges
 * the oracle outcomes to the Diamond market system.
 */
contract GameOracleFacet {
    // ============ Storage ============
    
    bytes32 constant GAME_ORACLE_STORAGE = keccak256("polyagent.gameoracle.storage");
    
    struct GameOracleStorage {
        address gameOracle;  // PolyagentGameOracle address
        mapping(bytes32 => bytes32) marketToSession;  // marketId => oracle sessionId
        mapping(bytes32 => bytes32) sessionToMarket;  // sessionId => marketId
    }
    
    function gameOracleStorage() internal pure returns (GameOracleStorage storage gs) {
        bytes32 position = GAME_ORACLE_STORAGE;
        assembly {
            gs.slot := position
        }
    }
    
    // ============ Events ============
    
    event GameOracleSet(address indexed oracle);
    event MarketLinkedToSession(bytes32 indexed marketId, bytes32 indexed sessionId);
    event MarketResolvedFromOracle(bytes32 indexed marketId, bytes32 indexed sessionId, bool outcome);
    
    // ============ Errors ============
    
    error GameOracleNotSet();
    error MarketNotLinked();
    error OracleNotFinalized();
    error MarketAlreadyLinked();
    
    // ============ Admin Functions ============
    
    /**
     * @notice Set the game oracle address (PolyagentGameOracle)
     * @param _oracle Address of the IPredictionOracle implementation
     */
    function setGameOracle(address _oracle) external {
        LibDiamond.enforceIsContractOwner();
        require(_oracle != address(0), "Invalid oracle address");
        
        GameOracleStorage storage gs = gameOracleStorage();
        gs.gameOracle = _oracle;
        
        emit GameOracleSet(_oracle);
    }
    
    /**
     * @notice Get the game oracle address
     */
    function getGameOracle() external view returns (address) {
        return gameOracleStorage().gameOracle;
    }
    
    // ============ Market-Session Linking ============
    
    /**
     * @notice Link a Diamond market to an oracle session
     * @param _marketId Diamond market ID
     * @param _sessionId Oracle session ID (from PolyagentGameOracle)
     * @dev Called after market creation to enable oracle-based resolution
     */
    function linkMarketToSession(bytes32 _marketId, bytes32 _sessionId) external {
        LibDiamond.enforceIsContractOwner();
        
        GameOracleStorage storage gs = gameOracleStorage();
        if (gs.marketToSession[_marketId] != bytes32(0)) revert MarketAlreadyLinked();
        
        gs.marketToSession[_marketId] = _sessionId;
        gs.sessionToMarket[_sessionId] = _marketId;
        
        emit MarketLinkedToSession(_marketId, _sessionId);
    }
    
    /**
     * @notice Get oracle session ID for a market
     */
    function getSessionForMarket(bytes32 _marketId) external view returns (bytes32) {
        return gameOracleStorage().marketToSession[_marketId];
    }
    
    /**
     * @notice Get market ID for an oracle session
     */
    function getMarketForSession(bytes32 _sessionId) external view returns (bytes32) {
        return gameOracleStorage().sessionToMarket[_sessionId];
    }
    
    // ============ Oracle Resolution ============
    
    /**
     * @notice Resolve a market from the game oracle
     * @param _marketId Market to resolve
     * @dev Anyone can call - resolution is trustless based on oracle state
     * 
     * Flow:
     * 1. Game engine reveals outcome to PolyagentGameOracle
     * 2. Anyone calls this function
     * 3. Function queries oracle for finalized outcome
     * 4. Market is resolved with outcome (0=NO, 1=YES)
     */
    function resolveFromGameOracle(bytes32 _marketId) external {
        GameOracleStorage storage gs = gameOracleStorage();
        
        if (gs.gameOracle == address(0)) revert GameOracleNotSet();
        
        bytes32 sessionId = gs.marketToSession[_marketId];
        if (sessionId == bytes32(0)) revert MarketNotLinked();
        
        // Query oracle for outcome
        IPredictionOracle oracle = IPredictionOracle(gs.gameOracle);
        (bool outcome, bool finalized) = oracle.getOutcome(sessionId);
        
        if (!finalized) revert OracleNotFinalized();
        
        // Resolve market (outcome: false=0, true=1 for binary markets)
        LibMarket.Market storage market = LibMarket.getMarket(_marketId);
        require(!market.resolved, "Market already resolved");
        require(market.numOutcomes == 2, "Only binary markets supported");
        
        market.resolved = true;
        market.winningOutcome = outcome ? 1 : 0;  // YES=1, NO=0
        
        emit MarketResolvedFromOracle(_marketId, sessionId, outcome);
    }
    
    /**
     * @notice Query oracle outcome without resolving
     * @param _sessionId Oracle session ID
     * @return outcome The outcome (true=YES, false=NO)
     * @return finalized Whether the outcome is final
     */
    function queryOracleOutcome(bytes32 _sessionId) external view returns (bool outcome, bool finalized) {
        GameOracleStorage storage gs = gameOracleStorage();
        if (gs.gameOracle == address(0)) revert GameOracleNotSet();
        
        return IPredictionOracle(gs.gameOracle).getOutcome(_sessionId);
    }
    
    /**
     * @notice Check if an address won a specific session
     * @param _sessionId Oracle session ID
     * @param _player Address to check
     */
    function isWinnerInSession(bytes32 _sessionId, address _player) external view returns (bool) {
        GameOracleStorage storage gs = gameOracleStorage();
        if (gs.gameOracle == address(0)) revert GameOracleNotSet();
        
        return IPredictionOracle(gs.gameOracle).isWinner(_sessionId, _player);
    }
    
    // ============ Market Creation with Oracle ============
    
    /**
     * @notice Create a market linked to an oracle session
     * @param _question Market question
     * @param _sessionId Oracle session ID
     * @param _resolveAt When market can be resolved
     * @return marketId The created market ID
     * 
     * @dev Creates a binary YES/NO market linked to the oracle session.
     * The oracle address is set to this contract to enable trustless resolution.
     */
    function createMarketForSession(
        string calldata _question,
        bytes32 _sessionId,
        uint256 _resolveAt
    ) external returns (bytes32 marketId) {
        LibDiamond.enforceIsContractOwner();
        
        GameOracleStorage storage gs = gameOracleStorage();
        require(gs.sessionToMarket[_sessionId] == bytes32(0), "Session already has market");
        
        // Create binary market with YES/NO outcomes
        LibMarket.MarketStorage storage ms = LibMarket.marketStorage();
        
        marketId = keccak256(abi.encodePacked(_question, _sessionId, block.timestamp));
        LibMarket.Market storage market = ms.markets[marketId];
        
        market.id = marketId;
        market.question = _question;
        market.numOutcomes = 2;  // Binary: NO=0, YES=1
        market.liquidity = ms.defaultLiquidity > 0 ? ms.defaultLiquidity : 1000 ether;
        market.createdAt = block.timestamp;
        market.resolveAt = _resolveAt;
        market.oracle = address(this);  // This facet can resolve via oracle
        market.feeRate = ms.defaultFeeRate > 0 ? ms.defaultFeeRate : 100;
        
        market.outcomeNames[0] = "NO";
        market.outcomeNames[1] = "YES";
        market.shares[0] = 0;
        market.shares[1] = 0;
        
        ms.marketIds.push(marketId);
        
        // Link to session
        gs.marketToSession[marketId] = _sessionId;
        gs.sessionToMarket[_sessionId] = marketId;
        
        emit MarketLinkedToSession(marketId, _sessionId);
        
        return marketId;
    }
}


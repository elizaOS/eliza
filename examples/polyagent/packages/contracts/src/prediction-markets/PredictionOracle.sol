// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import "./IPredictionOracle.sol";

/**
 * @title PredictionOracle
 * @notice TEE-backed oracle for prediction game outcomes
 * @dev Stores game results with TEE attestation for trustless verification
 * Implements IPredictionOracle for external contract integration
 */
contract PredictionOracle is IPredictionOracle {
    struct GameOutcome {
        bytes32 sessionId;
        string question;
        bool outcome;              // true = YES, false = NO
        bytes32 commitment;        // Hash committed at game start
        bytes32 salt;              // Salt for commitment
        uint256 startTime;
        uint256 endTime;
        bytes teeQuote;            // TEE attestation quote
        uint256 totalPayout;
        bool finalized;
    }

    mapping(bytes32 => GameOutcome) public games;
    mapping(bytes32 => bool) public commitments;
    mapping(bytes32 => address[]) private gameWinners;
    
    address public gameServer;
    uint256 public gameCount;
    address public dstackVerifier;

    event GameCommitted(
        bytes32 indexed sessionId,
        string question,
        bytes32 commitment,
        uint256 startTime
    );

    event GameRevealed(
        bytes32 indexed sessionId,
        bool outcome,
        uint256 endTime,
        bytes teeQuote,
        uint256 winnersCount
    );

    modifier onlyGameServer() {
        require(msg.sender == gameServer, "Only game server");
        _;
    }

    constructor(address _gameServer) {
        gameServer = _gameServer;
        dstackVerifier = address(0);
    }

    event DstackVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    /// @notice Set the dstack verifier address (address(0) to disable TEE verification)
    function setDstackVerifier(address _dstackVerifier) external onlyGameServer {
        address old = dstackVerifier;
        dstackVerifier = _dstackVerifier;
        emit DstackVerifierUpdated(old, _dstackVerifier);
    }

    /**
     * @notice Commit to a game outcome at start
     * @param sessionId Unique game session ID
     * @param question The yes/no question
     * @param commitment Hash of (outcome + salt)
     */
    function commitGame(
        bytes32 sessionId,
        string calldata question,
        bytes32 commitment
    ) external onlyGameServer {
        require(!commitments[commitment], "Commitment already exists");
        require(games[sessionId].startTime == 0, "Session already exists");

        games[sessionId] = GameOutcome({
            sessionId: sessionId,
            question: question,
            outcome: false,
            commitment: commitment,
            salt: bytes32(0),
            startTime: block.timestamp,
            endTime: 0,
            teeQuote: "",
            totalPayout: 0,
            finalized: false
        });

        commitments[commitment] = true;
        gameCount++;

        emit GameCommitted(sessionId, question, commitment, block.timestamp);
    }

    /**
     * @notice Reveal game outcome with TEE proof
     * @param sessionId Game session ID
     * @param outcome The outcome (true=YES, false=NO)
     * @param salt The salt used in commitment
     * @param teeQuote TEE attestation quote
     * @param winners List of winner addresses
     * @param totalPayout Total prize pool distributed
     */
    function revealGame(
        bytes32 sessionId,
        bool outcome,
        bytes32 salt,
        bytes memory teeQuote,
        address[] calldata winners,
        uint256 totalPayout
    ) external onlyGameServer {
        GameOutcome storage game = games[sessionId];
        require(game.startTime > 0, "Game not found");
        require(!game.finalized, "Already finalized");

        // Verify commitment
        bytes32 expectedCommitment = keccak256(abi.encode(outcome, salt));
        require(game.commitment == expectedCommitment, "Commitment mismatch");

        // CHECKS-EFFECTS-INTERACTIONS: Update state BEFORE external call
        game.outcome = outcome;
        game.salt = salt;
        game.endTime = block.timestamp;
        game.teeQuote = teeQuote;
        gameWinners[sessionId] = winners;
        game.totalPayout = totalPayout;
        game.finalized = true;

        // Verify TEE quote if verifier is set (external call AFTER state updates)
        if (dstackVerifier != address(0)) {
            (bool success, bytes memory result) = dstackVerifier.call(
                abi.encodeWithSignature(
                    "verify(bytes,uint256,bytes)",
                    teeQuote,
                    block.timestamp,
                    abi.encode(sessionId, outcome)
                )
            );
            require(success && abi.decode(result, (bool)), "TEE quote verification failed");
        }

        emit GameRevealed(sessionId, outcome, block.timestamp, teeQuote, winners.length);
    }
    
    // ============ IPredictionOracle Implementation ============

    /**
     * @notice Get winners array for a game
     * @param sessionId Game session ID
     * @return List of winner addresses
     */
    function getWinners(bytes32 sessionId) external view virtual override returns (address[] memory) {
        return gameWinners[sessionId];
    }

    /**
     * @notice Get game outcome
     */
    function getOutcome(bytes32 sessionId) external view override returns (bool outcome, bool finalized) {
        GameOutcome storage game = games[sessionId];
        return (game.outcome, game.finalized);
    }

    /**
     * @notice Check if address is a winner
     */
    function isWinner(bytes32 sessionId, address player) external view virtual override returns (bool) {
        GameOutcome storage game = games[sessionId];
        if (!game.finalized) return false;
        
        address[] storage winners = gameWinners[sessionId];
        for (uint i = 0; i < winners.length; i++) {
            if (winners[i] == player) return true;
        }
        return false;
    }

    /**
     * @notice Verify a commitment exists
     */
    function verifyCommitment(bytes32 commitment) external view override returns (bool) {
        return commitments[commitment];
    }
}

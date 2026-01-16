// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

/**
 * @title IPredictionOracle
 * @notice Interface for prediction game oracles
 * @dev Allows prediction market contracts to trustlessly access game results
 * 
 * Core Usage:
 *   (bool outcome, bool finalized) = oracle.getOutcome(sessionId);
 *   bool won = oracle.isWinner(sessionId, player);
 */
interface IPredictionOracle {
    // ============ Core Methods ============

    /**
     * @notice Get the outcome and finalization status of a game
     * @param sessionId The unique game session ID
     * @return outcome The game outcome (true=YES, false=NO)
     * @return finalized Whether the outcome has been revealed and finalized
     */
    function getOutcome(bytes32 sessionId) external view returns (bool outcome, bool finalized);

    /**
     * @notice Check if an address was a winner in a specific game
     * @param sessionId The game session ID
     * @param player The address to check
     * @return True if the address won, false otherwise
     */
    function isWinner(bytes32 sessionId, address player) external view returns (bool);

    /**
     * @notice Verify that a commitment exists in the oracle
     * @param commitment The commitment hash
     * @return True if commitment exists
     */
    function verifyCommitment(bytes32 commitment) external view returns (bool);

    /**
     * @notice Get the list of winners for a game
     * @param sessionId The game session ID
     * @return winners Array of winner addresses
     */
    function getWinners(bytes32 sessionId) external view returns (address[] memory winners);
}

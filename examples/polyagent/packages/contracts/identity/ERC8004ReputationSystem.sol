// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC8004IdentityRegistry} from "./ERC8004IdentityRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ERC8004ReputationSystem
/// @notice Reputation system for AI agents
/// @dev Tracks agent performance, accuracy, and trustworthiness
contract ERC8004ReputationSystem is Ownable {
    ERC8004IdentityRegistry public immutable identityRegistry;

    struct Reputation {
        uint256 totalBets;
        uint256 winningBets;
        uint256 totalVolume; // in wei
        uint256 profitLoss; // net profit/loss
        uint256 accuracyScore; // 0-10000 (0-100%)
        uint256 trustScore; // 0-10000, computed
        uint256 lastUpdated;
        bool isBanned;
    }

    struct FeedbackEntry {
        address from;
        uint256 agentTokenId;
        int8 rating; // -5 to +5
        string comment;
        uint256 timestamp;
    }

    mapping(uint256 => Reputation) public reputations;
    mapping(uint256 => FeedbackEntry[]) public feedback;
    mapping(uint256 => mapping(address => bool)) public hasFeedback; // Prevent spam
    
    /// @notice Authorized reporters that can record bets/wins/losses
    mapping(address => bool) public authorizedReporters;
    
    /// @notice Tracked agent token IDs for enumeration
    uint256[] private _trackedAgents;
    mapping(uint256 => bool) private _isTracked;

    // Reputation decay parameters
    uint256 public constant DECAY_PERIOD = 30 days;
    uint256 public constant MIN_BETS_FOR_SCORE = 10;

    event ReputationUpdated(uint256 indexed tokenId, uint256 accuracyScore, uint256 trustScore);
    event FeedbackSubmitted(uint256 indexed tokenId, address indexed from, int8 rating);
    event AgentBanned(uint256 indexed tokenId);
    event AgentUnbanned(uint256 indexed tokenId);
    event ReporterAuthorized(address indexed reporter);
    event ReporterRevoked(address indexed reporter);

    error OnlyAuthorizedReporter();

    modifier onlyReporter() {
        if (!authorizedReporters[msg.sender] && msg.sender != owner()) {
            revert OnlyAuthorizedReporter();
        }
        _;
    }

    constructor(address _identityRegistry) Ownable(msg.sender) {
        identityRegistry = ERC8004IdentityRegistry(_identityRegistry);
    }
    
    /// @notice Authorize a reporter to record bets/wins/losses
    function authorizeReporter(address reporter) external onlyOwner {
        authorizedReporters[reporter] = true;
        emit ReporterAuthorized(reporter);
    }
    
    /// @notice Revoke reporter authorization
    function revokeReporter(address reporter) external onlyOwner {
        authorizedReporters[reporter] = false;
        emit ReporterRevoked(reporter);
    }

    /// @notice Record a bet made by an agent
    /// @param _tokenId Agent token ID
    /// @param _amount Bet amount
    function recordBet(uint256 _tokenId, uint256 _amount) external onlyReporter {
        require(identityRegistry.ownerOf(_tokenId) != address(0), "Agent not registered");
        require(_amount > 0, "Amount must be positive");

        // Track agent if first interaction
        _trackAgent(_tokenId);

        Reputation storage rep = reputations[_tokenId];
        rep.totalBets++;
        rep.totalVolume += _amount;
        rep.lastUpdated = block.timestamp;

        _updateTrustScore(_tokenId);
    }

    /// @notice Record a winning bet
    /// @param _tokenId Agent token ID
    /// @param _profit Profit amount
    function recordWin(uint256 _tokenId, uint256 _profit) external onlyReporter {
        require(_profit > 0, "Profit must be positive");
        
        Reputation storage rep = reputations[_tokenId];
        rep.winningBets++;
        rep.profitLoss += _profit;
        rep.lastUpdated = block.timestamp;

        _updateAccuracyScore(_tokenId);
        _updateTrustScore(_tokenId);

        emit ReputationUpdated(_tokenId, rep.accuracyScore, rep.trustScore);
    }

    /// @notice Record a losing bet
    /// @param _tokenId Agent token ID
    /// @param _loss Loss amount
    function recordLoss(uint256 _tokenId, uint256 _loss) external onlyReporter {
        require(_loss > 0, "Loss must be positive");
        
        Reputation storage rep = reputations[_tokenId];
        rep.profitLoss -= _loss;
        rep.lastUpdated = block.timestamp;

        _updateAccuracyScore(_tokenId);
        _updateTrustScore(_tokenId);

        emit ReputationUpdated(_tokenId, rep.accuracyScore, rep.trustScore);
    }
    
    /// @notice Track an agent for enumeration
    function _trackAgent(uint256 _tokenId) internal {
        if (!_isTracked[_tokenId]) {
            _trackedAgents.push(_tokenId);
            _isTracked[_tokenId] = true;
        }
    }

    /// @notice Submit feedback for an agent
    /// @param _tokenId Agent token ID
    /// @param _rating Rating from -5 to +5
    /// @param _comment Feedback comment
    function submitFeedback(uint256 _tokenId, int8 _rating, string calldata _comment) external {
        address agentOwner = identityRegistry.ownerOf(_tokenId);
        require(agentOwner != address(0), "Agent not registered");
        require(agentOwner != msg.sender, "Cannot review self");
        require(!hasFeedback[_tokenId][msg.sender], "Already submitted feedback");
        require(_rating >= -5 && _rating <= 5, "Invalid rating");

        feedback[_tokenId].push(FeedbackEntry({
            from: msg.sender,
            agentTokenId: _tokenId,
            rating: _rating,
            comment: _comment,
            timestamp: block.timestamp
        }));

        hasFeedback[_tokenId][msg.sender] = true;

        _updateTrustScore(_tokenId);

        emit FeedbackSubmitted(_tokenId, msg.sender, _rating);
    }

    /// @notice Get reputation for agent
    function getReputation(uint256 _tokenId) external view returns (
        uint256 totalBets,
        uint256 winningBets,
        uint256 totalVolume,
        uint256 profitLoss,
        uint256 accuracyScore,
        uint256 trustScore,
        bool isBanned
    ) {
        Reputation storage rep = reputations[_tokenId];
        return (
            rep.totalBets,
            rep.winningBets,
            rep.totalVolume,
            rep.profitLoss,
            rep.accuracyScore,
            rep.trustScore,
            rep.isBanned
        );
    }

    /// @notice Get feedback count for agent
    function getFeedbackCount(uint256 _tokenId) external view returns (uint256) {
        return feedback[_tokenId].length;
    }

    /// @notice Get feedback entry
    function getFeedback(uint256 _tokenId, uint256 _index) external view returns (
        address from,
        int8 rating,
        string memory comment,
        uint256 timestamp
    ) {
        FeedbackEntry storage entry = feedback[_tokenId][_index];
        return (entry.from, entry.rating, entry.comment, entry.timestamp);
    }

    /// @notice Ban an agent (owner only)
    function banAgent(uint256 _tokenId) external onlyOwner {
        reputations[_tokenId].isBanned = true;
        emit AgentBanned(_tokenId);
    }

    /// @notice Unban an agent (owner only)
    function unbanAgent(uint256 _tokenId) external onlyOwner {
        reputations[_tokenId].isBanned = false;
        emit AgentUnbanned(_tokenId);
    }

    /// @notice Get agents with minimum trust score
    /// @param minScore Minimum trust score (0-10000 scale)
    /// @return tokenIds Array of token IDs meeting the minimum score
    function getAgentsByMinScore(uint256 minScore) external view returns (uint256[] memory) {
        uint256 trackedCount = _trackedAgents.length;
        uint256[] memory temp = new uint256[](trackedCount);
        uint256 count = 0;
        
        // Only iterate through tracked agents (those with recorded activity)
        for (uint256 i = 0; i < trackedCount; i++) {
            uint256 tokenId = _trackedAgents[i];
            Reputation storage rep = reputations[tokenId];
            if (!rep.isBanned && rep.trustScore >= minScore) {
                temp[count] = tokenId;
                count++;
            }
        }
        
        // Resize array to actual count
        uint256[] memory result = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = temp[i];
        }
        
        return result;
    }
    
    /// @notice Get total number of tracked agents
    function getTrackedAgentCount() external view returns (uint256) {
        return _trackedAgents.length;
    }
    
    /// @notice Get tracked agent at index
    function getTrackedAgentAt(uint256 index) external view returns (uint256) {
        require(index < _trackedAgents.length, "Index out of bounds");
        return _trackedAgents[index];
    }

    // Internal functions
    function _updateAccuracyScore(uint256 _tokenId) internal {
        Reputation storage rep = reputations[_tokenId];

        if (rep.totalBets < MIN_BETS_FOR_SCORE) {
            rep.accuracyScore = 5000; // Default 50%
            return;
        }

        // Accuracy = (winningBets / totalBets) * 10000
        rep.accuracyScore = (rep.winningBets * 10000) / rep.totalBets;
    }

    function _updateTrustScore(uint256 _tokenId) internal {
        Reputation storage rep = reputations[_tokenId];

        // Base score from accuracy
        uint256 baseScore = rep.accuracyScore;

        // Adjust for feedback
        int256 feedbackScore = _calculateFeedbackScore(_tokenId);
        int256 adjustedScore = int256(baseScore) + (feedbackScore * 100);

        // Apply decay for inactive agents
        uint256 timeSinceUpdate = block.timestamp - rep.lastUpdated;
        if (timeSinceUpdate > DECAY_PERIOD) {
            // Multiply first to avoid precision loss (1% per period)
            uint256 decayFactor = (timeSinceUpdate * 100) / DECAY_PERIOD;
            adjustedScore -= int256((uint256(adjustedScore) * decayFactor) / 10000);
        }

        // Clamp between 0 and 10000
        if (adjustedScore < 0) adjustedScore = 0;
        if (adjustedScore > 10000) adjustedScore = 10000;

        rep.trustScore = uint256(adjustedScore);
    }

    function _calculateFeedbackScore(uint256 _tokenId) internal view returns (int256) {
        FeedbackEntry[] storage entries = feedback[_tokenId];
        if (entries.length == 0) return 0;

        int256 total = 0;
        uint256 recentCount = 0;
        uint256 cutoff = block.timestamp > 30 days ? block.timestamp - 30 days : 0;

        for (uint256 i = 0; i < entries.length && recentCount < 10; i++) {
            if (entries[i].timestamp >= cutoff) {
                total += entries[i].rating;
                recentCount++;
            }
        }

        if (recentCount == 0) return 0;

        // Average rating * 20 (to scale to percentage points)
        return (total * 20) / int256(recentCount);
    }
}

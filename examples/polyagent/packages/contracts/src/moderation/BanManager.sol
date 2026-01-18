// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title BanManager
 * @notice Manages network-level and app-specific bans for agent identity system
 * @dev Separates app-level bans from network-level bans for granular moderation
 * 
 * Key Features:
 * - Network bans: Block agent from ALL Polyagent apps
 * - App-specific bans: Block agent from specific apps only
 * - Governance-controlled ban/unban operations
 * - Event-driven cache updates for performance
 * - Ban reason storage for transparency
 * - Appeal integration via governance
 * 
 * Integration:
 * - Governance calls ban functions after approval
 * - NetworkBanCache listens to events for real-time updates
 * - All apps query isAccessAllowed() before granting access
 */
contract BanManager is Ownable, Pausable {
    
    // ============ Structs ============
    
    struct BanRecord {
        bool isBanned;
        uint256 bannedAt;
        string reason;
        bytes32 proposalId;  // Link to governance proposal
    }
    
    // ============ State Variables ============
    
    /// @notice Network-wide bans (affects ALL apps)
    mapping(uint256 => BanRecord) public networkBans;
    
    /// @notice App-specific bans: agentId => appId => BanRecord
    mapping(uint256 => mapping(bytes32 => BanRecord)) public appBans;
    
    /// @notice Track which apps an agent is banned from
    mapping(uint256 => bytes32[]) private _agentAppBans;
    
    /// @notice Governance contract authorized to ban/unban
    address public governance;
    
    // ============ Events ============
    
    event NetworkBanApplied(
        uint256 indexed agentId,
        string reason,
        bytes32 indexed proposalId,
        uint256 timestamp
    );
    
    event AppBanApplied(
        uint256 indexed agentId,
        bytes32 indexed appId,
        string reason,
        bytes32 indexed proposalId,
        uint256 timestamp
    );
    
    event NetworkBanRemoved(
        uint256 indexed agentId,
        uint256 timestamp
    );
    
    event AppBanRemoved(
        uint256 indexed agentId,
        bytes32 indexed appId,
        uint256 timestamp
    );
    
    event GovernanceUpdated(
        address indexed oldGovernance,
        address indexed newGovernance
    );
    
    // ============ Errors ============
    
    error OnlyGovernance();
    error AlreadyBanned();
    error NotBanned();
    error InvalidAppId();
    error InvalidAgentId();
    
    // ============ Modifiers ============
    
    modifier onlyGovernance() {
        if (msg.sender != governance && msg.sender != owner()) {
            revert OnlyGovernance();
        }
        _;
    }
    
    // ============ Constructor ============
    
    constructor(address _governance, address _owner) Ownable(_owner) {
        require(_governance != address(0), "Invalid governance");
        governance = _governance;
    }
    
    // ============ Core Ban Functions ============
    
    /**
     * @notice Ban agent from entire network (all apps)
     * @param agentId Agent ID to ban
     * @param reason Reason for ban
     * @param proposalId Governance proposal ID
     * @dev Only callable by governance contract after futarchy approval
     */
    function banFromNetwork(
        uint256 agentId,
        string calldata reason,
        bytes32 proposalId
    ) external onlyGovernance whenNotPaused {
        if (agentId == 0) revert InvalidAgentId();
        if (networkBans[agentId].isBanned) revert AlreadyBanned();
        
        networkBans[agentId] = BanRecord({
            isBanned: true,
            bannedAt: block.timestamp,
            reason: reason,
            proposalId: proposalId
        });
        
        emit NetworkBanApplied(agentId, reason, proposalId, block.timestamp);
    }
    
    /**
     * @notice Ban agent from specific app only
     * @param agentId Agent ID to ban
     * @param appId App identifier (keccak256 of app name)
     * @param reason Reason for ban
     * @param proposalId Governance proposal ID
     */
    function banFromApp(
        uint256 agentId,
        bytes32 appId,
        string calldata reason,
        bytes32 proposalId
    ) external onlyGovernance whenNotPaused {
        if (agentId == 0) revert InvalidAgentId();
        if (appId == bytes32(0)) revert InvalidAppId();
        if (appBans[agentId][appId].isBanned) revert AlreadyBanned();
        
        appBans[agentId][appId] = BanRecord({
            isBanned: true,
            bannedAt: block.timestamp,
            reason: reason,
            proposalId: proposalId
        });
        
        // Track app ban for querying
        _agentAppBans[agentId].push(appId);
        
        emit AppBanApplied(agentId, appId, reason, proposalId, block.timestamp);
    }
    
    /**
     * @notice Remove network-wide ban (via appeal)
     * @param agentId Agent ID to unban
     */
    function unbanFromNetwork(
        uint256 agentId
    ) external onlyGovernance {
        if (!networkBans[agentId].isBanned) revert NotBanned();
        
        delete networkBans[agentId];
        
        emit NetworkBanRemoved(agentId, block.timestamp);
    }
    
    /**
     * @notice Remove app-specific ban
     * @param agentId Agent ID to unban
     * @param appId App identifier
     */
    function unbanFromApp(
        uint256 agentId,
        bytes32 appId
    ) external onlyGovernance {
        if (!appBans[agentId][appId].isBanned) revert NotBanned();
        
        delete appBans[agentId][appId];
        
        // Remove from tracking array
        bytes32[] storage bans = _agentAppBans[agentId];
        for (uint256 i = 0; i < bans.length; i++) {
            if (bans[i] == appId) {
                bans[i] = bans[bans.length - 1];
                bans.pop();
                break;
            }
        }
        
        emit AppBanRemoved(agentId, appId, block.timestamp);
    }
    
    // ============ Access Control Checks ============
    
    /**
     * @notice Check if agent has access to specific app
     * @param agentId Agent ID to check
     * @param appId App identifier
     * @return allowed True if access allowed, false if banned
     * @dev This is the main function apps call to check access
     */
    function isAccessAllowed(
        uint256 agentId,
        bytes32 appId
    ) external view returns (bool allowed) {
        // Network ban denies access to ALL apps
        if (networkBans[agentId].isBanned) {
            return false;
        }
        
        // App-specific ban
        if (appBans[agentId][appId].isBanned) {
            return false;
        }
        
        return true;
    }
    
    /**
     * @notice Check if agent is network banned
     * @param agentId Agent ID to check
     * @return True if network banned
     */
    function isNetworkBanned(
        uint256 agentId
    ) external view returns (bool) {
        return networkBans[agentId].isBanned;
    }
    
    /**
     * @notice Check if agent is banned from specific app
     * @param agentId Agent ID to check
     * @param appId App identifier
     * @return True if banned from app
     */
    function isAppBanned(
        uint256 agentId,
        bytes32 appId
    ) external view returns (bool) {
        return appBans[agentId][appId].isBanned;
    }
    
    /// @notice Address-based ban mapping for staking contract compatibility
    mapping(address => bool) public addressBans;
    
    /**
     * @notice Ban an address (for compute staking integration)
     * @param account Address to ban
     */
    function banAddress(address account) external onlyGovernance whenNotPaused {
        require(account != address(0), "Invalid address");
        addressBans[account] = true;
    }
    
    /**
     * @notice Unban an address
     * @param account Address to unban
     */
    function unbanAddress(address account) external onlyGovernance {
        addressBans[account] = false;
    }
    
    /**
     * @notice Check if an address is banned
     * @param account Address to check
     * @return True if address is banned
     */
    function isAddressBanned(address account) external view returns (bool) {
        return addressBans[account];
    }
    
    // ============ Query Functions ============
    
    /**
     * @notice Get list of apps agent is banned from
     * @param agentId Agent ID
     * @return Array of app IDs
     */
    function getAppBans(
        uint256 agentId
    ) external view returns (bytes32[] memory) {
        return _agentAppBans[agentId];
    }
    
    /**
     * @notice Get network ban details
     * @param agentId Agent ID
     * @return ban Full ban record
     */
    function getNetworkBan(
        uint256 agentId
    ) external view returns (BanRecord memory ban) {
        return networkBans[agentId];
    }
    
    /**
     * @notice Get app ban details
     * @param agentId Agent ID
     * @param appId App identifier
     * @return ban Full ban record
     */
    function getAppBan(
        uint256 agentId,
        bytes32 appId
    ) external view returns (BanRecord memory ban) {
        return appBans[agentId][appId];
    }
    
    /**
     * @notice Get ban reason for agent (network or app)
     * @param agentId Agent ID
     * @param appId App identifier (bytes32(0) for network ban)
     * @return reason Ban reason string
     */
    function getBanReason(
        uint256 agentId,
        bytes32 appId
    ) external view returns (string memory reason) {
        // Check network ban first
        if (networkBans[agentId].isBanned) {
            return networkBans[agentId].reason;
        }
        
        // Check app-specific ban
        if (appId != bytes32(0) && appBans[agentId][appId].isBanned) {
            return appBans[agentId][appId].reason;
        }
        
        return "";
    }
    
    // ============ Admin Functions ============
    
    /**
     * @notice Update governance contract address
     * @param newGovernance New governance contract
     */
    function setGovernance(address newGovernance) external onlyOwner {
        require(newGovernance != address(0), "Invalid governance");
        address oldGovernance = governance;
        governance = newGovernance;
        emit GovernanceUpdated(oldGovernance, newGovernance);
    }
    
    /**
     * @notice Pause contract in emergency
     */
    function pause() external onlyOwner {
        _pause();
    }
    
    /**
     * @notice Unpause contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /**
     * @notice Get contract version
     */
    function version() external pure returns (string memory) {
        return "1.0.0";
    }
}


// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import "../moderation/BanManager.sol";

/**
 * @title ComputeStaking
 * @notice Staking contract for compute marketplace participants
 * @dev Users and providers stake to participate, can be slashed for bad behavior
 */
contract ComputeStaking is Ownable, ReentrancyGuard, Pausable {
    
    // ============ Enums ============
    
    enum StakeType {
        USER,       // End users making inference requests
        PROVIDER,   // Compute providers offering inference
        GUARDIAN    // Guardians who vote on moderation
    }
    
    // ============ Structs ============
    
    struct Stake {
        uint256 amount;
        StakeType stakeType;
        uint256 stakedAt;
        uint256 lockedUntil;
        bool slashed;
    }
    
    // ============ Constants ============
    
    uint256 public constant MIN_USER_STAKE = 0.01 ether;
    uint256 public constant MIN_PROVIDER_STAKE = 0.1 ether;
    uint256 public constant MIN_GUARDIAN_STAKE = 1 ether;
    uint256 public constant STAKE_LOCKUP = 7 days;
    
    // ============ State Variables ============
    
    BanManager public immutable banManager;
    
    mapping(address => Stake) private _stakes;
    mapping(StakeType => uint256) public totalStaked;
    
    address[] private _users;
    address[] private _providers;
    address[] private _guardians;
    
    mapping(address => uint256) private _userIndex;
    mapping(address => uint256) private _providerIndex;
    mapping(address => uint256) private _guardianIndex;
    
    address public slasher;
    
    // ============ Events ============
    
    event Staked(
        address indexed account,
        StakeType stakeType,
        uint256 amount
    );
    
    event Unstaked(
        address indexed account,
        uint256 amount
    );
    
    event Slashed(
        address indexed account,
        uint256 amount,
        address indexed recipient,
        string reason
    );
    
    event StakeTypeUpgraded(
        address indexed account,
        StakeType oldType,
        StakeType newType
    );
    
    // ============ Errors ============
    
    error InsufficientStake();
    error StakeLocked();
    error NotStaked();
    error AlreadyStaked();
    error AccountBanned();
    error OnlySlasher();
    error InvalidAmount();
    
    // ============ Constructor ============
    
    constructor(address _banManager, address _owner) Ownable(_owner) {
        banManager = BanManager(_banManager);
        slasher = _owner;
    }
    
    // ============ Modifiers ============
    
    modifier onlySlasher() {
        if (msg.sender != slasher && msg.sender != owner()) {
            revert OnlySlasher();
        }
        _;
    }
    
    modifier notBanned() {
        // Check if sender is banned via BanManager
        require(!banManager.isAddressBanned(msg.sender), "Address is banned");
        _;
    }
    
    // ============ Staking Functions ============
    
    /**
     * @notice Stake as a user
     */
    function stakeAsUser() external payable nonReentrant whenNotPaused notBanned {
        if (msg.value < MIN_USER_STAKE) revert InsufficientStake();
        if (_stakes[msg.sender].amount > 0) revert AlreadyStaked();
        
        _stake(msg.sender, StakeType.USER, msg.value);
        _addToUserList(msg.sender);
    }
    
    /**
     * @notice Stake as a provider
     */
    function stakeAsProvider() external payable nonReentrant whenNotPaused notBanned {
        if (msg.value < MIN_PROVIDER_STAKE) revert InsufficientStake();
        if (_stakes[msg.sender].amount > 0) revert AlreadyStaked();
        
        _stake(msg.sender, StakeType.PROVIDER, msg.value);
        _addToProviderList(msg.sender);
    }
    
    /**
     * @notice Stake as a guardian
     */
    function stakeAsGuardian() external payable nonReentrant whenNotPaused notBanned {
        if (msg.value < MIN_GUARDIAN_STAKE) revert InsufficientStake();
        if (_stakes[msg.sender].amount > 0) revert AlreadyStaked();
        
        _stake(msg.sender, StakeType.GUARDIAN, msg.value);
        _addToGuardianList(msg.sender);
    }
    
    /**
     * @notice Add more stake
     */
    function addStake() external payable nonReentrant whenNotPaused {
        if (_stakes[msg.sender].amount == 0) revert NotStaked();
        if (msg.value == 0) revert InvalidAmount();
        
        _stakes[msg.sender].amount += msg.value;
        _stakes[msg.sender].lockedUntil = block.timestamp + STAKE_LOCKUP;
        totalStaked[_stakes[msg.sender].stakeType] += msg.value;
        
        emit Staked(msg.sender, _stakes[msg.sender].stakeType, msg.value);
    }
    
    /**
     * @notice Upgrade stake type (requires additional stake)
     */
    function upgradeStakeType(StakeType newType) external payable nonReentrant whenNotPaused {
        Stake storage stake = _stakes[msg.sender];
        if (stake.amount == 0) revert NotStaked();
        
        uint256 requiredStake = _getMinStake(newType);
        uint256 currentTotal = stake.amount + msg.value;
        
        if (currentTotal < requiredStake) revert InsufficientStake();
        
        // Remove from old list
        _removeFromTypeList(msg.sender, stake.stakeType);
        
        // Update totals
        totalStaked[stake.stakeType] -= stake.amount;
        
        StakeType oldType = stake.stakeType;
        stake.stakeType = newType;
        stake.amount = currentTotal;
        stake.lockedUntil = block.timestamp + STAKE_LOCKUP;
        
        totalStaked[newType] += currentTotal;
        
        // Add to new list
        _addToTypeList(msg.sender, newType);
        
        emit StakeTypeUpgraded(msg.sender, oldType, newType);
    }
    
    /**
     * @notice Unstake (after lockup period)
     */
    function unstake(uint256 amount) external nonReentrant {
        Stake storage stake = _stakes[msg.sender];
        if (stake.amount == 0) revert NotStaked();
        if (block.timestamp < stake.lockedUntil) revert StakeLocked();
        if (amount > stake.amount) revert InvalidAmount();
        
        stake.amount -= amount;
        totalStaked[stake.stakeType] -= amount;
        
        // Remove from list if fully unstaked
        if (stake.amount == 0) {
            _removeFromTypeList(msg.sender, stake.stakeType);
        }
        
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
        
        emit Unstaked(msg.sender, amount);
    }
    
    // ============ Slashing Functions ============
    
    /**
     * @notice Slash an account's stake
     * @param account Account to slash
     * @param amount Amount to slash
     * @param recipient Where to send slashed funds (address(0) = treasury)
     * @param reason Reason for slashing
     */
    function slash(
        address account,
        uint256 amount,
        address recipient,
        string calldata reason
    ) external onlySlasher {
        Stake storage stake = _stakes[account];
        if (stake.amount == 0) revert NotStaked();
        
        uint256 slashAmount = amount > stake.amount ? stake.amount : amount;
        stake.amount -= slashAmount;
        stake.slashed = true;
        totalStaked[stake.stakeType] -= slashAmount;
        
        // Remove from list if fully slashed
        if (stake.amount == 0) {
            _removeFromTypeList(account, stake.stakeType);
        }
        
        // Send to recipient or treasury
        address target = recipient == address(0) ? owner() : recipient;
        
        // Emit event BEFORE external call (CEI pattern)
        emit Slashed(account, slashAmount, target, reason);
        
        (bool success, ) = target.call{value: slashAmount}("");
        require(success, "Transfer failed");
    }
    
    // ============ Internal Functions ============
    
    function _stake(address account, StakeType stakeType, uint256 amount) internal {
        _stakes[account] = Stake({
            amount: amount,
            stakeType: stakeType,
            stakedAt: block.timestamp,
            lockedUntil: block.timestamp + STAKE_LOCKUP,
            slashed: false
        });
        
        totalStaked[stakeType] += amount;
        
        emit Staked(account, stakeType, amount);
    }
    
    function _getMinStake(StakeType stakeType) internal pure returns (uint256) {
        if (stakeType == StakeType.USER) return MIN_USER_STAKE;
        if (stakeType == StakeType.PROVIDER) return MIN_PROVIDER_STAKE;
        if (stakeType == StakeType.GUARDIAN) return MIN_GUARDIAN_STAKE;
        return 0;
    }
    
    function _addToUserList(address account) internal {
        _userIndex[account] = _users.length;
        _users.push(account);
    }
    
    function _addToProviderList(address account) internal {
        _providerIndex[account] = _providers.length;
        _providers.push(account);
    }
    
    function _addToGuardianList(address account) internal {
        _guardianIndex[account] = _guardians.length;
        _guardians.push(account);
    }
    
    function _addToTypeList(address account, StakeType stakeType) internal {
        if (stakeType == StakeType.USER) _addToUserList(account);
        else if (stakeType == StakeType.PROVIDER) _addToProviderList(account);
        else if (stakeType == StakeType.GUARDIAN) _addToGuardianList(account);
    }
    
    function _removeFromTypeList(address account, StakeType stakeType) internal {
        if (stakeType == StakeType.USER) _removeFromUserList(account);
        else if (stakeType == StakeType.PROVIDER) _removeFromProviderList(account);
        else if (stakeType == StakeType.GUARDIAN) _removeFromGuardianList(account);
    }
    
    function _removeFromUserList(address account) internal {
        // Safety check: verify the account is actually in the list at the stored index
        uint256 index = _userIndex[account];
        if (_users.length == 0 || (index == 0 && (_users.length == 0 || _users[0] != account))) {
            return; // Account not in list or already removed
        }
        
        uint256 lastIndex = _users.length - 1;
        
        if (index != lastIndex) {
            address last = _users[lastIndex];
            _users[index] = last;
            _userIndex[last] = index;
        }
        
        _users.pop();
        delete _userIndex[account];
    }
    
    function _removeFromProviderList(address account) internal {
        // Safety check: verify the account is actually in the list at the stored index
        uint256 index = _providerIndex[account];
        if (_providers.length == 0 || (index == 0 && (_providers.length == 0 || _providers[0] != account))) {
            return; // Account not in list or already removed
        }
        
        uint256 lastIndex = _providers.length - 1;
        
        if (index != lastIndex) {
            address last = _providers[lastIndex];
            _providers[index] = last;
            _providerIndex[last] = index;
        }
        
        _providers.pop();
        delete _providerIndex[account];
    }
    
    function _removeFromGuardianList(address account) internal {
        // Safety check: verify the account is actually in the list at the stored index
        uint256 index = _guardianIndex[account];
        if (_guardians.length == 0 || (index == 0 && (_guardians.length == 0 || _guardians[0] != account))) {
            return; // Account not in list or already removed
        }
        
        uint256 lastIndex = _guardians.length - 1;
        
        if (index != lastIndex) {
            address last = _guardians[lastIndex];
            _guardians[index] = last;
            _guardianIndex[last] = index;
        }
        
        _guardians.pop();
        delete _guardianIndex[account];
    }
    
    // ============ View Functions ============
    
    function getStake(address account) external view returns (Stake memory) {
        return _stakes[account];
    }
    
    function getStakeAmount(address account) external view returns (uint256) {
        return _stakes[account].amount;
    }
    
    function getStakeType(address account) external view returns (StakeType) {
        return _stakes[account].stakeType;
    }
    
    function isStaked(address account) external view returns (bool) {
        return _stakes[account].amount > 0;
    }
    
    function isProvider(address account) external view returns (bool) {
        return _stakes[account].stakeType == StakeType.PROVIDER && 
               _stakes[account].amount >= MIN_PROVIDER_STAKE;
    }
    
    function isGuardian(address account) external view returns (bool) {
        return _stakes[account].stakeType == StakeType.GUARDIAN && 
               _stakes[account].amount >= MIN_GUARDIAN_STAKE;
    }
    
    function getUsers() external view returns (address[] memory) {
        return _users;
    }
    
    function getProviders() external view returns (address[] memory) {
        return _providers;
    }
    
    function getGuardians() external view returns (address[] memory) {
        return _guardians;
    }
    
    function getGuardianCount() external view returns (uint256) {
        return _guardians.length;
    }
    
    // ============ Admin Functions ============
    
    event SlasherUpdated(address indexed oldSlasher, address indexed newSlasher);

    function setSlasher(address newSlasher) external onlyOwner {
        require(newSlasher != address(0), "Invalid slasher address");
        address oldSlasher = slasher;
        slasher = newSlasher;
        emit SlasherUpdated(oldSlasher, newSlasher);
    }
    
    function pause() external onlyOwner {
        _pause();
    }
    
    function unpause() external onlyOwner {
        _unpause();
    }
    
    function version() external pure returns (string memory) {
        return "1.0.0";
    }
}


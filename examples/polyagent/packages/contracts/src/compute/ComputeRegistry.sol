// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import "./IComputeRegistry.sol";

/**
 * @title ComputeRegistry
 * @notice Registry for compute providers in the Polyagent network
 * @dev Providers stake ETH to register and can be slashed for bad behavior
 */
contract ComputeRegistry is IComputeRegistry, Ownable, ReentrancyGuard, Pausable {
    
    // ============ Constants ============
    
    uint256 public constant MIN_PROVIDER_STAKE = 0.01 ether;
    uint256 public constant STAKE_LOCKUP_PERIOD = 7 days;
    
    // ============ State Variables ============
    
    mapping(address => Provider) private _providers;
    mapping(address => Capability[]) private _capabilities;
    mapping(address => uint256) private _stakeLockUntil;
    
    address[] private _activeProviders;
    mapping(address => uint256) private _activeProviderIndex;
    
    address public slasher;
    
    // ============ Constructor ============
    
    constructor(address _owner) Ownable(_owner) {
        slasher = _owner;
    }
    
    // ============ Modifiers ============
    
    modifier onlyProviderOwner(address provider) {
        if (_providers[provider].owner != msg.sender) {
            revert OnlyProviderOwner();
        }
        _;
    }
    
    modifier onlySlasher() {
        require(msg.sender == slasher || msg.sender == owner(), "Only slasher");
        _;
    }
    
    // ============ Registration ============
    
    /**
     * @notice Register as a compute provider
     * @param name Human-readable provider name
     * @param endpoint URL of the inference endpoint
     * @param attestationHash Hash of hardware attestation
     * @return Provider address
     */
    function register(
        string calldata name,
        string calldata endpoint,
        bytes32 attestationHash
    ) external payable nonReentrant whenNotPaused returns (address) {
        if (msg.value < MIN_PROVIDER_STAKE) {
            revert InsufficientStake();
        }
        if (_providers[msg.sender].registeredAt != 0) {
            revert ProviderAlreadyRegistered();
        }
        if (bytes(endpoint).length == 0) {
            revert InvalidEndpoint();
        }
        
        _providers[msg.sender] = Provider({
            owner: msg.sender,
            name: name,
            endpoint: endpoint,
            attestationHash: attestationHash,
            stake: msg.value,
            registeredAt: block.timestamp,
            active: true
        });
        
        // Add to active providers list
        _activeProviderIndex[msg.sender] = _activeProviders.length;
        _activeProviders.push(msg.sender);
        
        // Lock stake
        _stakeLockUntil[msg.sender] = block.timestamp + STAKE_LOCKUP_PERIOD;
        
        emit ProviderRegistered(msg.sender, name, endpoint, msg.value);
        
        return msg.sender;
    }
    
    /**
     * @notice Update provider endpoint
     */
    function updateEndpoint(string calldata endpoint) external onlyProviderOwner(msg.sender) {
        if (bytes(endpoint).length == 0) {
            revert InvalidEndpoint();
        }
        _providers[msg.sender].endpoint = endpoint;
        emit ProviderUpdated(msg.sender, endpoint, _providers[msg.sender].attestationHash);
    }
    
    /**
     * @notice Update attestation hash
     */
    function updateAttestation(bytes32 attestationHash) external onlyProviderOwner(msg.sender) {
        _providers[msg.sender].attestationHash = attestationHash;
        emit ProviderUpdated(msg.sender, _providers[msg.sender].endpoint, attestationHash);
    }
    
    /**
     * @notice Deactivate provider (stop accepting new requests)
     */
    function deactivate() external onlyProviderOwner(msg.sender) {
        if (!_providers[msg.sender].active) {
            revert ProviderNotActive();
        }
        
        _providers[msg.sender].active = false;
        _removeFromActiveList(msg.sender);
        
        emit ProviderDeactivated(msg.sender);
    }
    
    /**
     * @notice Reactivate provider
     */
    function reactivate() external onlyProviderOwner(msg.sender) {
        Provider storage provider = _providers[msg.sender];
        require(!provider.active, "Already active");
        require(provider.stake >= MIN_PROVIDER_STAKE, "Insufficient stake");
        
        provider.active = true;
        _activeProviderIndex[msg.sender] = _activeProviders.length;
        _activeProviders.push(msg.sender);
    }
    
    /**
     * @notice Withdraw stake (after lockup period)
     */
    function withdraw(uint256 amount) external nonReentrant onlyProviderOwner(msg.sender) {
        Provider storage provider = _providers[msg.sender];
        
        if (block.timestamp < _stakeLockUntil[msg.sender]) {
            revert StakeLocked();
        }
        
        require(amount <= provider.stake, "Insufficient stake");
        
        uint256 remainingStake = provider.stake - amount;
        
        // If withdrawing below minimum, must deactivate
        if (remainingStake < MIN_PROVIDER_STAKE && provider.active) {
            provider.active = false;
            _removeFromActiveList(msg.sender);
            emit ProviderDeactivated(msg.sender);
        }
        
        provider.stake = remainingStake;
        
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
    }
    
    /**
     * @notice Add stake to provider
     */
    function addStake() external payable onlyProviderOwner(msg.sender) {
        _providers[msg.sender].stake += msg.value;
        _stakeLockUntil[msg.sender] = block.timestamp + STAKE_LOCKUP_PERIOD;
    }
    
    // ============ Capabilities ============
    
    /**
     * @notice Add a model capability
     */
    function addCapability(
        string calldata model,
        uint256 pricePerInputToken,
        uint256 pricePerOutputToken,
        uint256 maxContextLength
    ) external onlyProviderOwner(msg.sender) {
        _capabilities[msg.sender].push(Capability({
            model: model,
            pricePerInputToken: pricePerInputToken,
            pricePerOutputToken: pricePerOutputToken,
            maxContextLength: maxContextLength
        }));
        
        emit CapabilityAdded(msg.sender, model, pricePerInputToken, pricePerOutputToken);
    }
    
    /**
     * @notice Remove a capability by index
     */
    function removeCapability(uint256 index) external onlyProviderOwner(msg.sender) {
        Capability[] storage caps = _capabilities[msg.sender];
        require(index < caps.length, "Invalid index");
        
        caps[index] = caps[caps.length - 1];
        caps.pop();
    }
    
    // ============ Slashing ============
    
    /**
     * @notice Slash provider stake for bad behavior
     * @param provider Provider to slash
     * @param amount Amount to slash
     * @param reason Reason for slashing
     */
    function slash(
        address provider,
        uint256 amount,
        string calldata reason
    ) external onlySlasher {
        Provider storage p = _providers[provider];
        if (p.registeredAt == 0) {
            revert ProviderNotRegistered();
        }
        
        uint256 slashAmount = amount > p.stake ? p.stake : amount;
        p.stake -= slashAmount;
        
        // Deactivate if below minimum
        if (p.stake < MIN_PROVIDER_STAKE && p.active) {
            p.active = false;
            _removeFromActiveList(provider);
            emit ProviderDeactivated(provider);
        }
        
        // Emit event BEFORE external call (CEI pattern)
        emit ProviderSlashed(provider, slashAmount, reason);
        
        // Send slashed amount to treasury (owner)
        (bool success, ) = owner().call{value: slashAmount}("");
        require(success, "Transfer failed");
    }
    
    // ============ View Functions ============
    
    function getProvider(address provider) external view returns (Provider memory) {
        return _providers[provider];
    }
    
    function getCapabilities(address provider) external view returns (Capability[] memory) {
        return _capabilities[provider];
    }
    
    function isActive(address provider) external view returns (bool) {
        return _providers[provider].active;
    }
    
    function getActiveProviders() external view returns (address[] memory) {
        return _activeProviders;
    }
    
    function getProviderStake(address provider) external view returns (uint256) {
        return _providers[provider].stake;
    }
    
    function getStakeLockUntil(address provider) external view returns (uint256) {
        return _stakeLockUntil[provider];
    }
    
    function getActiveProviderCount() external view returns (uint256) {
        return _activeProviders.length;
    }
    
    // ============ Internal Functions ============
    
    function _removeFromActiveList(address provider) internal {
        uint256 index = _activeProviderIndex[provider];
        uint256 lastIndex = _activeProviders.length - 1;
        
        if (index != lastIndex) {
            address lastProvider = _activeProviders[lastIndex];
            _activeProviders[index] = lastProvider;
            _activeProviderIndex[lastProvider] = index;
        }
        
        _activeProviders.pop();
        delete _activeProviderIndex[provider];
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


// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./IComputeRegistry.sol";
import "./LedgerManager.sol";

/**
 * @title InferenceServing
 * @notice Handles inference request verification and settlement
 * @dev Providers sign responses, users verify and settle on-chain
 */
contract InferenceServing is Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    
    // ============ Structs ============
    
    struct Service {
        address provider;
        string model;
        string endpoint;
        uint256 pricePerInputToken;
        uint256 pricePerOutputToken;
        bool active;
    }
    
    struct Settlement {
        address user;
        address provider;
        bytes32 requestHash;
        uint256 inputTokens;
        uint256 outputTokens;
        uint256 fee;
        uint256 timestamp;
    }
    
    // ============ State Variables ============
    
    IComputeRegistry public immutable registry;
    LedgerManager public immutable ledger;
    
    /// @notice Services by provider
    mapping(address => Service[]) private _providerServices;
    
    /// @notice All settlements
    mapping(bytes32 => Settlement) public settlements;
    
    /// @notice Nonces for replay protection
    mapping(address => mapping(address => uint256)) public nonces;
    
    /// @notice Provider signer keys (for TEE-bound signing)
    mapping(address => address) public providerSigners;
    
    // ============ Events ============
    
    event ServiceRegistered(
        address indexed provider,
        string model,
        uint256 pricePerInputToken,
        uint256 pricePerOutputToken
    );
    
    event ServiceDeactivated(address indexed provider, uint256 serviceIndex);
    
    event SignerUpdated(address indexed provider, address indexed signer);
    
    event InferenceSettled(
        address indexed user,
        address indexed provider,
        bytes32 indexed requestHash,
        uint256 inputTokens,
        uint256 outputTokens,
        uint256 fee
    );
    
    event DisputeRaised(
        address indexed user,
        address indexed provider,
        bytes32 indexed requestHash,
        string reason
    );
    
    // ============ Errors ============
    
    error ProviderNotRegistered();
    error ServiceNotFound();
    error InvalidSignature();
    error InvalidNonce();
    error RequestAlreadySettled();
    error InsufficientBalance();
    error InvalidTokenCounts();
    
    // ============ Constructor ============
    
    constructor(
        address _registry,
        address _ledger,
        address _owner
    ) Ownable(_owner) {
        registry = IComputeRegistry(_registry);
        ledger = LedgerManager(_ledger);
    }
    
    // ============ Service Management ============
    
    /**
     * @notice Register a service (model) for inference
     */
    function registerService(
        string calldata model,
        string calldata endpoint,
        uint256 pricePerInputToken,
        uint256 pricePerOutputToken
    ) external whenNotPaused {
        if (!registry.isActive(msg.sender)) {
            revert ProviderNotRegistered();
        }
        
        _providerServices[msg.sender].push(Service({
            provider: msg.sender,
            model: model,
            endpoint: endpoint,
            pricePerInputToken: pricePerInputToken,
            pricePerOutputToken: pricePerOutputToken,
            active: true
        }));
        
        emit ServiceRegistered(msg.sender, model, pricePerInputToken, pricePerOutputToken);
    }
    
    /**
     * @notice Deactivate a service
     */
    function deactivateService(uint256 serviceIndex) external {
        Service[] storage services = _providerServices[msg.sender];
        require(serviceIndex < services.length, "Invalid index");
        
        services[serviceIndex].active = false;
        
        emit ServiceDeactivated(msg.sender, serviceIndex);
    }
    
    /**
     * @notice Set the signer key for TEE-bound responses
     */
    function setSigner(address signer) external {
        if (!registry.isActive(msg.sender)) {
            revert ProviderNotRegistered();
        }
        
        providerSigners[msg.sender] = signer;
        
        emit SignerUpdated(msg.sender, signer);
    }
    
    // ============ Inference Settlement ============
    
    /**
     * @notice Settle an inference request
     * @param provider Provider address
     * @param requestHash Hash of the request
     * @param inputTokens Number of input tokens
     * @param outputTokens Number of output tokens
     * @param nonce Request nonce
     * @param signature Provider signature over (requestHash, inputTokens, outputTokens, nonce)
     */
    function settle(
        address provider,
        bytes32 requestHash,
        uint256 inputTokens,
        uint256 outputTokens,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Verify nonce
        if (nonce != nonces[msg.sender][provider]) {
            revert InvalidNonce();
        }
        
        // Check not already settled
        bytes32 settlementId = keccak256(abi.encodePacked(msg.sender, provider, requestHash));
        if (settlements[settlementId].timestamp != 0) {
            revert RequestAlreadySettled();
        }
        
        // Verify signature
        address signer = providerSigners[provider];
        if (signer == address(0)) {
            signer = provider; // Default to provider address
        }
        
        bytes32 messageHash = keccak256(abi.encodePacked(
            msg.sender,
            provider,
            requestHash,
            inputTokens,
            outputTokens,
            nonce
        ));
        
        bytes32 ethSignedHash = messageHash.toEthSignedMessageHash();
        address recovered = ethSignedHash.recover(signature);
        
        if (recovered != signer) {
            revert InvalidSignature();
        }
        
        // Calculate fee
        Service[] storage services = _providerServices[provider];
        uint256 fee = 0;
        
        // Use first active service for pricing (simplified)
        for (uint256 i = 0; i < services.length; i++) {
            if (services[i].active) {
                fee = (inputTokens * services[i].pricePerInputToken) + 
                      (outputTokens * services[i].pricePerOutputToken);
                break;
            }
        }
        
        // CHECKS-EFFECTS-INTERACTIONS: Update state BEFORE external call
        // Record settlement
        settlements[settlementId] = Settlement({
            user: msg.sender,
            provider: provider,
            requestHash: requestHash,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            fee: fee,
            timestamp: block.timestamp
        });
        
        // Increment nonce
        nonces[msg.sender][provider]++;
        
        // External call AFTER state updates
        ledger.processSettlement(msg.sender, provider, fee, inputTokens, outputTokens);
        
        emit InferenceSettled(msg.sender, provider, requestHash, inputTokens, outputTokens, fee);
    }
    
    /**
     * @notice Batch settle multiple requests
     */
    function batchSettle(
        address provider,
        bytes32[] calldata requestHashes,
        uint256[] calldata inputTokenCounts,
        uint256[] calldata outputTokenCounts,
        uint256 startNonce,
        bytes calldata aggregateSignature
    ) external nonReentrant whenNotPaused {
        uint256 len = requestHashes.length;
        require(len == inputTokenCounts.length && len == outputTokenCounts.length, "Length mismatch");
        
        // Verify signature over all requests
        address signer = providerSigners[provider];
        if (signer == address(0)) {
            signer = provider;
        }
        
        // Use abi.encode instead of encodePacked to prevent hash collision with dynamic arrays
        bytes32 batchHash = keccak256(abi.encode(
            msg.sender,
            provider,
            requestHashes,
            inputTokenCounts,
            outputTokenCounts,
            startNonce
        ));
        
        bytes32 ethSignedHash = batchHash.toEthSignedMessageHash();
        address recovered = ethSignedHash.recover(aggregateSignature);
        
        if (recovered != signer) {
            revert InvalidSignature();
        }
        
        // Get pricing
        Service[] storage services = _providerServices[provider];
        uint256 pricePerInput = 0;
        uint256 pricePerOutput = 0;
        
        for (uint256 i = 0; i < services.length; i++) {
            if (services[i].active) {
                pricePerInput = services[i].pricePerInputToken;
                pricePerOutput = services[i].pricePerOutputToken;
                break;
            }
        }
        
        // Process all settlements
        uint256 totalFee = 0;
        uint256 totalInput = 0;
        uint256 totalOutput = 0;
        
        for (uint256 i = 0; i < len; i++) {
            bytes32 settlementId = keccak256(abi.encodePacked(msg.sender, provider, requestHashes[i]));
            
            if (settlements[settlementId].timestamp == 0) {
                uint256 fee = (inputTokenCounts[i] * pricePerInput) + 
                              (outputTokenCounts[i] * pricePerOutput);
                
                settlements[settlementId] = Settlement({
                    user: msg.sender,
                    provider: provider,
                    requestHash: requestHashes[i],
                    inputTokens: inputTokenCounts[i],
                    outputTokens: outputTokenCounts[i],
                    fee: fee,
                    timestamp: block.timestamp
                });
                
                totalFee += fee;
                totalInput += inputTokenCounts[i];
                totalOutput += outputTokenCounts[i];
            }
        }
        
        // Update nonce BEFORE external call (CEI pattern)
        nonces[msg.sender][provider] = startNonce + len;
        
        // Single settlement for total
        if (totalFee > 0) {
            ledger.processSettlement(msg.sender, provider, totalFee, totalInput, totalOutput);
        }
    }
    
    // ============ View Functions ============
    
    function getServices(address provider) external view returns (Service[] memory) {
        return _providerServices[provider];
    }
    
    function getActiveServices(address provider) external view returns (Service[] memory) {
        Service[] storage all = _providerServices[provider];
        
        // Count active
        uint256 activeCount = 0;
        for (uint256 i = 0; i < all.length; i++) {
            if (all[i].active) activeCount++;
        }
        
        // Build result
        Service[] memory active = new Service[](activeCount);
        uint256 j = 0;
        for (uint256 i = 0; i < all.length; i++) {
            if (all[i].active) {
                active[j] = all[i];
                j++;
            }
        }
        
        return active;
    }
    
    function getSettlement(
        address user,
        address provider,
        bytes32 requestHash
    ) external view returns (Settlement memory) {
        bytes32 settlementId = keccak256(abi.encodePacked(user, provider, requestHash));
        return settlements[settlementId];
    }
    
    function getNonce(address user, address provider) external view returns (uint256) {
        return nonces[user][provider];
    }
    
    function getSigner(address provider) external view returns (address) {
        address signer = providerSigners[provider];
        return signer == address(0) ? provider : signer;
    }
    
    function calculateFee(
        address provider,
        uint256 inputTokens,
        uint256 outputTokens
    ) external view returns (uint256) {
        Service[] storage services = _providerServices[provider];
        
        for (uint256 i = 0; i < services.length; i++) {
            if (services[i].active) {
                return (inputTokens * services[i].pricePerInputToken) + 
                       (outputTokens * services[i].pricePerOutputToken);
            }
        }
        
        return 0;
    }
    
    // ============ Admin Functions ============
    
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


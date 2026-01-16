// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

/**
 * @title IComputeRegistry
 * @notice Interface for the compute provider registry
 */
interface IComputeRegistry {
    struct Provider {
        address owner;
        string name;
        string endpoint;
        bytes32 attestationHash;
        uint256 stake;
        uint256 registeredAt;
        bool active;
    }

    struct Capability {
        string model;
        uint256 pricePerInputToken;
        uint256 pricePerOutputToken;
        uint256 maxContextLength;
    }

    event ProviderRegistered(
        address indexed provider,
        string name,
        string endpoint,
        uint256 stake
    );

    event ProviderUpdated(
        address indexed provider,
        string endpoint,
        bytes32 attestationHash
    );

    event ProviderDeactivated(address indexed provider);
    
    event ProviderSlashed(
        address indexed provider,
        uint256 amount,
        string reason
    );

    event CapabilityAdded(
        address indexed provider,
        string model,
        uint256 pricePerInputToken,
        uint256 pricePerOutputToken
    );

    error InsufficientStake();
    error ProviderNotRegistered();
    error ProviderAlreadyRegistered();
    error ProviderNotActive();
    error OnlyProviderOwner();
    error InvalidEndpoint();
    error StakeLocked();

    function register(
        string calldata name,
        string calldata endpoint,
        bytes32 attestationHash
    ) external payable returns (address);

    function updateEndpoint(string calldata endpoint) external;
    function updateAttestation(bytes32 attestationHash) external;
    function deactivate() external;
    function withdraw(uint256 amount) external;

    function addCapability(
        string calldata model,
        uint256 pricePerInputToken,
        uint256 pricePerOutputToken,
        uint256 maxContextLength
    ) external;

    function getProvider(address provider) external view returns (Provider memory);
    function getCapabilities(address provider) external view returns (Capability[] memory);
    function isActive(address provider) external view returns (bool);
    function getActiveProviders() external view returns (address[] memory);
    function getProviderStake(address provider) external view returns (uint256);
}


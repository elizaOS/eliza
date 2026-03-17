// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockMiladyAgentRegistry
 * @dev Mock ERC-8004 Agent Identity Registry for testing.
 *
 * Implements the core interface expected by RegistryService:
 * - Agent registration (self and delegated)
 * - Profile updates
 * - Token URI management
 * - Status queries
 */
contract MockMiladyAgentRegistry is ERC721URIStorage, Ownable {
    struct Agent {
        string name;
        string endpoint;
        bytes32 capabilitiesHash;
        bool isActive;
    }

    uint256 private _tokenIdCounter;
    mapping(uint256 => Agent) private _agents;
    mapping(address => uint256) private _addressToTokenId;
    mapping(string => bool) private _endpointTaken;

    event AgentRegistered(
        uint256 indexed tokenId,
        address indexed owner,
        string name,
        string endpoint
    );
    event AgentUpdated(
        uint256 indexed tokenId,
        string endpoint,
        bytes32 capabilitiesHash
    );

    constructor() ERC721("Milady Agent Registry", "MILAIDY") {
        _tokenIdCounter = 1; // Start at 1, 0 means unregistered
    }

    /**
     * @dev Register calling address as an agent.
     */
    function registerAgent(
        string memory name,
        string memory endpoint,
        bytes32 capabilitiesHash,
        string memory uri
    ) external returns (uint256) {
        return _registerAgentFor(msg.sender, name, endpoint, capabilitiesHash, uri);
    }

    /**
     * @dev Register an agent for another address (delegated registration).
     */
    function registerAgentFor(
        address owner,
        string memory name,
        string memory endpoint,
        bytes32 capabilitiesHash,
        string memory uri
    ) external returns (uint256) {
        return _registerAgentFor(owner, name, endpoint, capabilitiesHash, uri);
    }

    function _registerAgentFor(
        address owner,
        string memory name,
        string memory endpoint,
        bytes32 capabilitiesHash,
        string memory uri
    ) internal returns (uint256) {
        require(_addressToTokenId[owner] == 0, "Address already registered");
        require(!_endpointTaken[endpoint], "Endpoint already taken");

        uint256 tokenId = _tokenIdCounter++;
        _safeMint(owner, tokenId);
        _setTokenURI(tokenId, uri);

        _agents[tokenId] = Agent({
            name: name,
            endpoint: endpoint,
            capabilitiesHash: capabilitiesHash,
            isActive: true
        });

        _addressToTokenId[owner] = tokenId;
        _endpointTaken[endpoint] = true;

        emit AgentRegistered(tokenId, owner, name, endpoint);
        return tokenId;
    }

    /**
     * @dev Update agent endpoint and capabilities hash.
     */
    function updateAgent(
        string memory endpoint,
        bytes32 capabilitiesHash
    ) external {
        uint256 tokenId = _addressToTokenId[msg.sender];
        require(tokenId != 0, "Not registered");
        require(ownerOf(tokenId) == msg.sender, "Not owner");

        Agent storage agent = _agents[tokenId];

        // Free old endpoint if changing
        if (keccak256(bytes(agent.endpoint)) != keccak256(bytes(endpoint))) {
            _endpointTaken[agent.endpoint] = false;
            require(!_endpointTaken[endpoint], "Endpoint already taken");
            _endpointTaken[endpoint] = true;
            agent.endpoint = endpoint;
        }

        agent.capabilitiesHash = capabilitiesHash;

        emit AgentUpdated(tokenId, endpoint, capabilitiesHash);
    }

    /**
     * @dev Update full agent profile (name, endpoint, capabilities, tokenURI).
     */
    function updateAgentProfile(
        string memory name,
        string memory endpoint,
        bytes32 capabilitiesHash,
        string memory uri
    ) external {
        uint256 tokenId = _addressToTokenId[msg.sender];
        require(tokenId != 0, "Not registered");
        require(ownerOf(tokenId) == msg.sender, "Not owner");

        Agent storage agent = _agents[tokenId];

        // Free old endpoint if changing
        if (keccak256(bytes(agent.endpoint)) != keccak256(bytes(endpoint))) {
            _endpointTaken[agent.endpoint] = false;
            require(!_endpointTaken[endpoint], "Endpoint already taken");
            _endpointTaken[endpoint] = true;
        }

        agent.name = name;
        agent.endpoint = endpoint;
        agent.capabilitiesHash = capabilitiesHash;
        _setTokenURI(tokenId, uri);

        emit AgentUpdated(tokenId, endpoint, capabilitiesHash);
    }

    /**
     * @dev Update tokenURI for a specific token.
     */
    function updateTokenURI(uint256 tokenId, string memory uri) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        _setTokenURI(tokenId, uri);
    }

    /**
     * @dev Deactivate the caller's agent.
     */
    function deactivateAgent() external {
        uint256 tokenId = _addressToTokenId[msg.sender];
        require(tokenId != 0, "Not registered");
        _agents[tokenId].isActive = false;
    }

    /**
     * @dev Reactivate the caller's agent.
     */
    function reactivateAgent() external {
        uint256 tokenId = _addressToTokenId[msg.sender];
        require(tokenId != 0, "Not registered");
        _agents[tokenId].isActive = true;
    }

    // ── View functions ──────────────────────────────────────────────────────

    function getAgentInfo(uint256 tokenId)
        external
        view
        returns (string memory, string memory, bytes32, bool)
    {
        Agent storage agent = _agents[tokenId];
        return (
            agent.name,
            agent.endpoint,
            agent.capabilitiesHash,
            agent.isActive
        );
    }

    function addressToTokenId(address addr) external view returns (uint256) {
        return _addressToTokenId[addr];
    }

    function isRegistered(address addr) external view returns (bool) {
        return _addressToTokenId[addr] != 0;
    }

    function getTokenId(address addr) external view returns (uint256) {
        return _addressToTokenId[addr];
    }

    function totalAgents() external view returns (uint256) {
        return _tokenIdCounter - 1; // Counter starts at 1
    }

    function isEndpointTaken(string memory endpoint) external view returns (bool) {
        return _endpointTaken[endpoint];
    }
}

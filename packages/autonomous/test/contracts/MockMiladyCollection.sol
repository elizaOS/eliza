// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title MockMiladyCollection
 * @dev Mock ERC-8041 fixed-supply collection for testing.
 *
 * Implements the core interface expected by DropService:
 * - Public free mint (user pays gas)
 * - Shiny mint (0.1 ETH + gas)
 * - Whitelist mint (Merkle proof)
 * - Supply tracking
 */
contract MockMiladyCollection is ERC721URIStorage, Ownable {
    uint256 public constant MAX_SUPPLY = 2138;
    uint256 public constant SHINY_PRICE = 0.1 ether;

    uint256 private _currentSupply;
    bool public publicMintOpen;
    bool public whitelistMintOpen;
    bytes32 public merkleRoot;

    mapping(address => bool) private _hasMinted;
    mapping(uint256 => uint256) private _agentMintNumber;
    mapping(uint256 => bool) private _isShiny;

    event AgentMinted(
        uint256 indexed agentId,
        uint256 indexed mintNumber,
        address indexed owner,
        bool shiny
    );
    event CollectionUpdated(
        uint256 maxSupply,
        uint256 currentSupply,
        bool publicOpen,
        bool whitelistOpen
    );

    constructor() ERC721("Milady Maker", "MILAIDYMAKER") {
        publicMintOpen = true;
        whitelistMintOpen = false;
    }

    // ── Admin functions ────────────────────────────────────────────────────

    function setPublicMintOpen(bool open) external onlyOwner {
        publicMintOpen = open;
        emit CollectionUpdated(MAX_SUPPLY, _currentSupply, publicMintOpen, whitelistMintOpen);
    }

    function setWhitelistMintOpen(bool open) external onlyOwner {
        whitelistMintOpen = open;
        emit CollectionUpdated(MAX_SUPPLY, _currentSupply, publicMintOpen, whitelistMintOpen);
    }

    function setMerkleRoot(bytes32 root) external onlyOwner {
        merkleRoot = root;
    }

    // ── Mint functions ─────────────────────────────────────────────────────

    /**
     * @dev Public free mint (one per address).
     */
    function mint(
        string memory name,
        string memory endpoint,
        bytes32 capabilitiesHash
    ) external returns (uint256) {
        require(publicMintOpen, "Public mint not open");
        require(!_hasMinted[msg.sender], "Already minted");
        require(_currentSupply < MAX_SUPPLY, "Sold out");

        return _doMint(msg.sender, name, endpoint, capabilitiesHash, false);
    }

    /**
     * @dev Shiny mint (0.1 ETH, one per address).
     */
    function mintShiny(
        string memory name,
        string memory endpoint,
        bytes32 capabilitiesHash
    ) external payable returns (uint256) {
        require(publicMintOpen, "Public mint not open");
        require(!_hasMinted[msg.sender], "Already minted");
        require(_currentSupply < MAX_SUPPLY, "Sold out");
        require(msg.value >= SHINY_PRICE, "Insufficient payment");

        return _doMint(msg.sender, name, endpoint, capabilitiesHash, true);
    }

    /**
     * @dev Whitelist mint with Merkle proof.
     */
    function mintWhitelist(
        string memory name,
        string memory endpoint,
        bytes32 capabilitiesHash,
        bytes32[] calldata proof
    ) external returns (uint256) {
        require(whitelistMintOpen, "Whitelist mint not open");
        require(!_hasMinted[msg.sender], "Already minted");
        require(_currentSupply < MAX_SUPPLY, "Sold out");

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "Invalid proof");

        return _doMint(msg.sender, name, endpoint, capabilitiesHash, false);
    }

    /**
     * @dev Mint for another address (delegated mint).
     */
    function mintFor(
        address to,
        string memory name,
        string memory endpoint,
        bytes32 capabilitiesHash,
        bool shiny
    ) external returns (uint256) {
        require(publicMintOpen, "Public mint not open");
        require(!_hasMinted[to], "Already minted");
        require(_currentSupply < MAX_SUPPLY, "Sold out");

        return _doMint(to, name, endpoint, capabilitiesHash, shiny);
    }

    function _doMint(
        address to,
        string memory, // name - not stored in this simple mock
        string memory, // endpoint - not stored in this simple mock
        bytes32, // capabilitiesHash - not stored in this simple mock
        bool shiny
    ) internal returns (uint256) {
        _currentSupply++;
        uint256 tokenId = _currentSupply;
        uint256 mintNumber = _currentSupply;

        _safeMint(to, tokenId);
        _hasMinted[to] = true;
        _agentMintNumber[tokenId] = mintNumber;
        _isShiny[tokenId] = shiny;

        // Set a default token URI
        string memory uri = shiny
            ? "ipfs://QmShinyMiladyMetadata"
            : "ipfs://QmMiladyMetadata";
        _setTokenURI(tokenId, uri);

        emit AgentMinted(tokenId, mintNumber, to, shiny);
        emit CollectionUpdated(MAX_SUPPLY, _currentSupply, publicMintOpen, whitelistMintOpen);

        return tokenId;
    }

    // ── View functions ─────────────────────────────────────────────────────

    function currentSupply() external view returns (uint256) {
        return _currentSupply;
    }

    function hasMinted(address addr) external view returns (bool) {
        return _hasMinted[addr];
    }

    function getAgentMintNumber(uint256 tokenId) external view returns (uint256) {
        return _agentMintNumber[tokenId];
    }

    function isShiny(uint256 tokenId) external view returns (bool) {
        return _isShiny[tokenId];
    }

    function getCollectionDetails()
        external
        view
        returns (uint256 maxSupply, uint256 supply, bool publicOpen)
    {
        return (MAX_SUPPLY, _currentSupply, publicMintOpen);
    }

    // ── Withdraw ───────────────────────────────────────────────────────────

    function withdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No balance");
        payable(owner()).transfer(balance);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ProtoMonkeysNFT
 * @author Polyagent Team
 * @notice ERC-721 NFT collection with signature-gated minting for Polyagent's top 100 users
 * @dev Uses ECDSA signatures for off-chain eligibility verification
 *
 * The mint flow:
 * 1. Backend verifies user eligibility (top 100 leaderboard snapshot)
 * 2. Backend generates a signed message with (to, deadline, nonce, chainId, contractAddress)
 * 3. User calls mint() with the signature
 * 4. Contract verifies signature and assigns a random token ID (1-100)
 *
 * Security features:
 * - Signature verification prevents unauthorized minting
 * - Deadline prevents replay after expiration
 * - Nonce prevents signature reuse
 * - One mint per address
 * - ReentrancyGuard protects mint function
 *
 * Note on randomness: This contract uses block.prevrandao and other on-chain values for
 * random token ID selection. This is acceptable because all tokens have equal value and
 * the randomness only affects which ID (1-100) is assigned, not mint eligibility.
 */
contract ProtoMonkeysNFT is ERC721, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ============ Constants ============

    /// @notice Maximum supply of the collection
    uint256 public constant MAX_SUPPLY = 100;

    // ============ State Variables ============
    // Storage is packed for gas efficiency:
    // Slot N: signer (20 bytes) + totalMinted (12 bytes) = 32 bytes

    /// @notice Address authorized to sign mint messages
    address public signer;

    /// @notice Total number of tokens minted (max 100, fits in uint96)
    uint96 public totalMinted;

    /// @notice Base URI for token metadata
    string private _baseTokenURI;

    /// @notice Tracks which addresses have already minted
    mapping(address minter => bool minted) public hasMinted;

    /// @notice Tracks which nonces have been used (prevents replay)
    mapping(bytes32 nonce => bool used) public usedNonces;

    /// @notice Array of available token IDs (1-100, shrinks as minted)
    /// @dev Packed as uint8[] to reduce deployment/storage gas (MAX_SUPPLY = 100)
    uint8[] private _availableTokenIds;

    // ============ Events ============

    /**
     * @notice Emitted when the signer address is updated
     * @param oldSigner The previous signer address
     * @param newSigner The new signer address
     */
    event SignerUpdated(address indexed oldSigner, address indexed newSigner);

    /**
     * @notice Emitted when the base URI is updated
     * @param oldBaseURI The previous base URI
     * @param newBaseURI The new base URI
     */
    event BaseURIUpdated(string oldBaseURI, string newBaseURI);

    /**
     * @notice Emitted when an NFT is minted
     * @param to The address receiving the NFT
     * @param tokenId The token ID that was minted
     * @param nonce The nonce used for this mint
     */
    event NFTMinted(address indexed to, uint256 indexed tokenId, bytes32 indexed nonce);

    // ============ Errors ============

    /// @notice Thrown when signature verification fails
    error InvalidSignature();

    /// @notice Thrown when the deadline has passed
    error DeadlineExpired();

    /// @notice Thrown when a nonce has already been used
    error NonceAlreadyUsed();

    /// @notice Thrown when an address has already minted
    error AlreadyMinted();

    /// @notice Thrown when all NFTs have been minted
    error SoldOut();

    /// @notice Thrown when setting zero address as signer
    error InvalidSigner();

    /// @notice Thrown when minting to zero address
    error InvalidRecipient();

    // ============ Constructor ============

    /**
     * @notice Deploy the ProtoMonkeysNFT contract
     * @param signer_ Address authorized to sign mint messages
     * @param baseTokenURI_ Base URI for token metadata
     */
    constructor(
        address signer_,
        string memory baseTokenURI_
    ) ERC721("ProtoMonkeys", "PROTO") Ownable(msg.sender) {
        if (signer_ == address(0)) revert InvalidSigner();

        signer = signer_;
        _baseTokenURI = baseTokenURI_;

        // Initialize available token IDs (1-100) with gas-optimized loop
        uint8[] storage available = _availableTokenIds;
        unchecked {
            for (uint256 i = 1; i < MAX_SUPPLY + 1; ++i) {
                available.push(uint8(i));
            }
        }
    }

    // ============ External Functions ============

    /**
     * @notice Mint an NFT with a valid signature from the authorized signer
     * @param to Address to mint the NFT to
     * @param deadline Timestamp after which the signature is invalid
     * @param nonce Unique nonce to prevent replay attacks
     * @param signature ECDSA signature from the authorized signer
     * @dev The signature must be over keccak256(abi.encodePacked(to, deadline, nonce, chainId, contractAddress))
     *      signed using eth_sign (with the "\x19Ethereum Signed Message:\n32" prefix)
     */
    function mint(
        address to,
        uint256 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant {
        // Cache storage reads for gas efficiency
        address currentSigner = signer;
        uint96 mintedBefore = totalMinted;
        // Invariant: _availableTokenIds.length == MAX_SUPPLY - totalMinted
        uint256 availableLength = MAX_SUPPLY - uint256(mintedBefore);
        uint8[] storage available = _availableTokenIds;
        // Validation checks (fail fast, cheapest checks first)
        if (to == address(0)) revert InvalidRecipient();
        if (availableLength == 0) revert SoldOut();
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (usedNonces[nonce]) revert NonceAlreadyUsed();
        if (hasMinted[to]) revert AlreadyMinted();

        // Verify signature
        bytes32 messageHash = keccak256(
            abi.encodePacked(to, deadline, nonce, block.chainid, address(this))
        );
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();
        if (_recoverSigner(ethSignedMessageHash, signature) != currentSigner) revert InvalidSignature();

        // Update state
        usedNonces[nonce] = true;
        hasMinted[to] = true;

        // Pick random token ID using minimal entropy (sufficient for equal-value tokens)
        // solhint-disable-next-line not-rely-on-time
        uint256 randomIndex;
        unchecked {
            randomIndex =
                uint256(keccak256(abi.encodePacked(block.prevrandao, to, mintedBefore))) %
                availableLength;
        }

        uint256 tokenId = available[randomIndex];

        // Remove from available pool (swap and pop)
        unchecked {
            uint256 lastIndex = availableLength - 1;
            if (randomIndex != lastIndex) {
                available[randomIndex] = available[lastIndex];
            }
            ++totalMinted;
            // Decrease array length without clearing storage.
            // Safe because this array is only ever shrunk after construction (never grown again).
            // slither-disable-next-line assembly-usage
            assembly ("memory-safe") { // solhint-disable-line no-inline-assembly
                sstore(available.slot, lastIndex)
            }
        }

        // Mint and emit event
        _safeMint(to, tokenId);
        emit NFTMinted(to, tokenId, nonce);
    }

    // ============ Owner Functions ============

    /**
     * @notice Update the authorized signer address
     * @param newSigner New signer address
     */
    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidSigner();
        emit SignerUpdated(signer, newSigner);
        signer = newSigner;
    }

    /**
     * @notice Update the base URI for token metadata
     * @param newBaseURI New base URI
     */
    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        emit BaseURIUpdated(_baseTokenURI, newBaseURI);
        _baseTokenURI = newBaseURI;
    }

    // ============ View Functions ============

    /**
     * @notice Returns the number of tokens still available to mint
     * @return count Number of available tokens
     */
    function availableSupply() external view returns (uint256 count) {
        return _availableTokenIds.length;
    }

    /**
     * @notice Returns the base URI for token metadata
     * @return uri Base URI string
     */
    function baseURI() external view returns (string memory uri) {
        return _baseTokenURI;
    }

    /**
     * @notice Check if a nonce has been used
     * @param nonce The nonce to check
     * @return used True if the nonce has been used
     */
    function isNonceUsed(bytes32 nonce) external view returns (bool used) {
        return usedNonces[nonce];
    }

    // ============ Internal Functions ============

    /**
     * @notice Recover signer from an eth_sign message hash
     * @dev Supports both standard 65-byte signatures and ERC-2098 64-byte short signatures.
     * @param ethSignedMessageHash The EIP-191 prefixed message hash
     * @param signature The signature bytes (64 or 65 bytes)
     * @return recovered The recovered signer, or address(0) on failure
     */
    function _recoverSigner(
        bytes32 ethSignedMessageHash,
        bytes calldata signature
    ) internal pure returns (address recovered) {
        // Supports both standard 65-byte signatures and ERC-2098 64-byte short signatures.
        uint256 sigLen = signature.length;
        if (sigLen == 65) {
            ECDSA.RecoverError err;
            bytes32 errArg;
            (recovered, err, errArg) = ECDSA.tryRecover(ethSignedMessageHash, signature);
            return err == ECDSA.RecoverError.NoError ? recovered : address(0);
        }

        if (sigLen == 64) {
            // Support ERC-2098 short signatures (r, vs). This can save 32 calldata bytes per mint.
            bytes memory sig = signature;
            bytes32 r;
            bytes32 vs;
            assembly ("memory-safe") { // solhint-disable-line no-inline-assembly
                r := mload(add(sig, 0x20))
                vs := mload(add(sig, 0x40))
            }

            ECDSA.RecoverError err;
            bytes32 errArg;
            (recovered, err, errArg) = ECDSA.tryRecover(ethSignedMessageHash, r, vs);
            return err == ECDSA.RecoverError.NoError ? recovered : address(0);
        }

        return address(0);
    }

    /**
     * @notice Override to return custom base URI
     * @return uri Base URI string
     */
    function _baseURI() internal view override returns (string memory uri) {
        return _baseTokenURI;
    }
}

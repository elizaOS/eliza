// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Test.sol";
import "../src/nft/ProtoMonkeysNFT.sol";

/**
 * @title ProtoMonkeysNFTTest
 * @notice Comprehensive test suite for ProtoMonkeysNFT contract
 * @dev Tests cover deployment, minting, security, edge cases, and invariants
 */
contract ProtoMonkeysNFTTest is Test {
    ProtoMonkeysNFT public nft;

    // Test accounts
    address public owner;
    address public signer;
    uint256 public signerPrivateKey;
    address public user1;
    address public user2;
    address public user3;

    // Test constants
    string public constant BASE_URI = "https://polyagent.market/api/nft/metadata/";
    uint256 public constant DEFAULT_DEADLINE = 1 hours;

    // Events to test
    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event BaseURIUpdated(string oldBaseURI, string newBaseURI);
    event NFTMinted(
        address indexed to,
        uint256 indexed tokenId,
        bytes32 indexed nonce
    );
    event Transfer(
        address indexed from,
        address indexed to,
        uint256 indexed tokenId
    );

    function setUp() public {
        // Setup test accounts
        owner = address(this);
        signerPrivateKey = 0xA11CE;
        signer = vm.addr(signerPrivateKey);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");
        user3 = makeAddr("user3");

        // Give users some ETH for gas
        vm.deal(user1, 10 ether);
        vm.deal(user2, 10 ether);
        vm.deal(user3, 10 ether);

        // Deploy contract
        nft = new ProtoMonkeysNFT(signer, BASE_URI);
    }

    // ============ Deployment Tests ============

    function test_deployment_setsCorrectName() public view {
        assertEq(nft.name(), "ProtoMonkeys");
    }

    function test_deployment_setsCorrectSymbol() public view {
        assertEq(nft.symbol(), "PROTO");
    }

    function test_deployment_setsCorrectSigner() public view {
        assertEq(nft.signer(), signer);
    }

    function test_deployment_setsCorrectBaseURI() public view {
        assertEq(nft.baseURI(), BASE_URI);
    }

    function test_deployment_setsCorrectOwner() public view {
        assertEq(nft.owner(), owner);
    }

    function test_deployment_initializes100AvailableTokens() public view {
        assertEq(nft.availableSupply(), 100);
    }

    function test_deployment_totalMintedIsZero() public view {
        assertEq(nft.totalMinted(), 0);
    }

    function test_deployment_maxSupplyIsCorrect() public view {
        assertEq(nft.MAX_SUPPLY(), 100);
    }

    function test_deployment_revertsWithZeroSigner() public {
        vm.expectRevert(ProtoMonkeysNFT.InvalidSigner.selector);
        new ProtoMonkeysNFT(address(0), BASE_URI);
    }

    function test_deployment_supportsERC721() public view {
        // ERC721 interface ID
        assertTrue(nft.supportsInterface(0x80ac58cd));
    }

    function test_deployment_supportsERC721Metadata() public view {
        // ERC721Metadata interface ID
        assertTrue(nft.supportsInterface(0x5b5e139f));
    }

    function test_deployment_supportsERC165() public view {
        // ERC165 interface ID
        assertTrue(nft.supportsInterface(0x01ffc9a7));
    }

    // ============ Successful Minting Tests ============

    function test_mint_successfulMint() public {
        (bytes32 nonce, uint256 deadline, bytes memory signature) = _createSignature(user1);

        vm.prank(user1);
        nft.mint(user1, deadline, nonce, signature);

        assertEq(nft.balanceOf(user1), 1);
        assertEq(nft.totalMinted(), 1);
        assertEq(nft.availableSupply(), 99);
        assertTrue(nft.hasMinted(user1));
        assertTrue(nft.isNonceUsed(nonce));
    }

    function test_mint_anyoneCanSubmitValidSignature() public {
        // user2 submits signature for user1
        (bytes32 nonce, uint256 deadline, bytes memory signature) = _createSignature(user1);

        vm.prank(user2);
        nft.mint(user1, deadline, nonce, signature);

        assertEq(nft.balanceOf(user1), 1);
        assertEq(nft.balanceOf(user2), 0);
    }

    function test_mint_emitsTransferEvent() public {
        (bytes32 nonce, uint256 deadline, bytes memory signature) = _createSignature(user1);

        vm.prank(user1);
        // Verify Transfer event is emitted with from=0 (mint) and to=user1
        // We don't check tokenId as it's randomly assigned
        vm.expectEmit(true, true, false, false);
        emit Transfer(address(0), user1, 0); // tokenId not checked (3rd param is false)
        nft.mint(user1, deadline, nonce, signature);
    }

    function test_mint_emitsNFTMintedEvent() public {
        (bytes32 nonce, uint256 deadline, bytes memory signature) = _createSignature(user1);

        vm.prank(user1);
        vm.expectEmit(true, false, true, false);
        emit NFTMinted(user1, 0, nonce); // tokenId is unpredictable
        nft.mint(user1, deadline, nonce, signature);
    }

    function test_mint_multipleUsersCanMint() public {
        // User1 mints
        (bytes32 nonce1, uint256 deadline1, bytes memory sig1) = _createSignatureWithNonce(user1, bytes32(uint256(1)));
        vm.prank(user1);
        nft.mint(user1, deadline1, nonce1, sig1);

        // User2 mints
        (bytes32 nonce2, uint256 deadline2, bytes memory sig2) = _createSignatureWithNonce(user2, bytes32(uint256(2)));
        vm.prank(user2);
        nft.mint(user2, deadline2, nonce2, sig2);

        // User3 mints
        (bytes32 nonce3, uint256 deadline3, bytes memory sig3) = _createSignatureWithNonce(user3, bytes32(uint256(3)));
        vm.prank(user3);
        nft.mint(user3, deadline3, nonce3, sig3);

        assertEq(nft.totalMinted(), 3);
        assertEq(nft.availableSupply(), 97);
        assertEq(nft.balanceOf(user1), 1);
        assertEq(nft.balanceOf(user2), 1);
        assertEq(nft.balanceOf(user3), 1);
    }

    // ============ Mint Failure Tests ============

    function test_mint_revertsIfAlreadyMinted() public {
        (bytes32 nonce1, uint256 deadline1, bytes memory sig1) = _createSignatureWithNonce(user1, bytes32(uint256(1)));
        vm.prank(user1);
        nft.mint(user1, deadline1, nonce1, sig1);

        (bytes32 nonce2, uint256 deadline2, bytes memory sig2) = _createSignatureWithNonce(user1, bytes32(uint256(2)));
        vm.prank(user1);
        vm.expectRevert(ProtoMonkeysNFT.AlreadyMinted.selector);
        nft.mint(user1, deadline2, nonce2, sig2);
    }

    function test_mint_revertsIfDeadlineExpired() public {
        uint256 expiredDeadline = block.timestamp - 1;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory signature = _sign(user1, expiredDeadline, nonce);

        vm.prank(user1);
        vm.expectRevert(ProtoMonkeysNFT.DeadlineExpired.selector);
        nft.mint(user1, expiredDeadline, nonce, signature);
    }

    function test_mint_revertsIfDeadlineExactlyAtTimestamp() public {
        // Deadline exactly at block.timestamp should succeed (not expired)
        uint256 exactDeadline = block.timestamp;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory signature = _sign(user1, exactDeadline, nonce);

        vm.prank(user1);
        // Should NOT revert - deadline is >= block.timestamp
        nft.mint(user1, exactDeadline, nonce, signature);
        assertEq(nft.balanceOf(user1), 1);
    }

    function test_mint_revertsIfNonceAlreadyUsed() public {
        bytes32 nonce = bytes32(uint256(1));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(user1, deadline, nonce);

        vm.prank(user1);
        nft.mint(user1, deadline, nonce, signature);

        // Try to use same nonce for different user
        bytes memory signature2 = _sign(user2, deadline, nonce);
        vm.prank(user2);
        vm.expectRevert(ProtoMonkeysNFT.NonceAlreadyUsed.selector);
        nft.mint(user2, deadline, nonce, signature2);
    }

    function test_mint_revertsIfInvalidSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));

        // Sign for user1 but try to mint for user2
        bytes memory wrongSignature = _sign(user1, deadline, nonce);

        vm.prank(user2);
        vm.expectRevert(ProtoMonkeysNFT.InvalidSignature.selector);
        nft.mint(user2, deadline, nonce, wrongSignature);
    }

    function test_mint_revertsIfSignedByWrongKey() public {
        uint256 wrongPrivateKey = 0xBAD;
        address wrongSigner = vm.addr(wrongPrivateKey);
        require(wrongSigner != signer, "Wrong signer should be different");

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));

        // Sign with wrong key
        bytes32 messageHash = keccak256(
            abi.encodePacked(user1, deadline, nonce, block.chainid, address(nft))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPrivateKey, ethSignedMessageHash);
        bytes memory wrongSignature = abi.encodePacked(r, s, v);

        vm.prank(user1);
        vm.expectRevert(ProtoMonkeysNFT.InvalidSignature.selector);
        nft.mint(user1, deadline, nonce, wrongSignature);
    }

    function test_mint_revertsWithInvalidRecipient() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory signature = _sign(address(0), deadline, nonce);

        vm.expectRevert(ProtoMonkeysNFT.InvalidRecipient.selector);
        nft.mint(address(0), deadline, nonce, signature);
    }

    function test_mint_revertsWhenSoldOut() public {
        // Mint all 100
        for (uint256 i = 0; i < 100; i++) {
            address minter = address(uint160(100 + i));
            vm.deal(minter, 1 ether);
            (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignatureWithNonce(
                minter,
                bytes32(i)
            );
            vm.prank(minter);
            nft.mint(minter, deadline, nonce, sig);
        }

        assertEq(nft.availableSupply(), 0);
        assertEq(nft.totalMinted(), 100);

        // Try to mint one more
        address extraMinter = address(200);
        (bytes32 extraNonce, uint256 extraDeadline, bytes memory extraSig) = _createSignatureWithNonce(
            extraMinter,
            bytes32(uint256(200))
        );

        vm.prank(extraMinter);
        vm.expectRevert(ProtoMonkeysNFT.SoldOut.selector);
        nft.mint(extraMinter, extraDeadline, extraNonce, extraSig);
    }

    // ============ Token ID Range Tests ============

    function test_mint_assignsTokenIdsBetween1And100() public {
        bool[] memory seenTokenIds = new bool[](101); // Index 0-100

        for (uint256 i = 0; i < 20; i++) {
            address minter = address(uint160(100 + i));
            vm.deal(minter, 1 ether);
            (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignatureWithNonce(
                minter,
                bytes32(i)
            );
            vm.prank(minter);
            nft.mint(minter, deadline, nonce, sig);

            // Find the token ID owned by minter
            uint256 tokenId = _findTokenIdOwnedBy(minter);
            assertTrue(tokenId >= 1 && tokenId <= 100, "Token ID out of range");
            assertFalse(seenTokenIds[tokenId], "Duplicate token ID assigned");
            seenTokenIds[tokenId] = true;
        }
    }

    function test_mint_allTokenIdsUnique() public {
        uint256[] memory mintedTokenIds = new uint256[](100);

        // Mint all 100
        for (uint256 i = 0; i < 100; i++) {
            address minter = address(uint160(100 + i));
            vm.deal(minter, 1 ether);
            (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignatureWithNonce(
                minter,
                bytes32(i)
            );
            vm.prank(minter);
            nft.mint(minter, deadline, nonce, sig);
            mintedTokenIds[i] = _findTokenIdOwnedBy(minter);
        }

        // Verify all unique
        for (uint256 i = 0; i < 100; i++) {
            for (uint256 j = i + 1; j < 100; j++) {
                assertNotEq(
                    mintedTokenIds[i],
                    mintedTokenIds[j],
                    "Duplicate token ID found"
                );
            }
        }
    }

    // ============ Owner Function Tests ============

    function test_setSigner_onlyOwner() public {
        address newSigner = makeAddr("newSigner");

        vm.prank(user1);
        vm.expectRevert();
        nft.setSigner(newSigner);

        nft.setSigner(newSigner);
        assertEq(nft.signer(), newSigner);
    }

    function test_setSigner_emitsEvent() public {
        address newSigner = makeAddr("newSigner");

        vm.expectEmit(true, true, false, false);
        emit SignerUpdated(signer, newSigner);
        nft.setSigner(newSigner);
    }

    function test_setSigner_revertsWithZeroAddress() public {
        vm.expectRevert(ProtoMonkeysNFT.InvalidSigner.selector);
        nft.setSigner(address(0));
    }

    function test_setSigner_allowsMintWithNewSigner() public {
        uint256 newSignerPrivateKey = 0xBEEF;
        address newSigner = vm.addr(newSignerPrivateKey);

        nft.setSigner(newSigner);

        // Create signature with new signer
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes32 messageHash = keccak256(
            abi.encodePacked(user1, deadline, nonce, block.chainid, address(nft))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newSignerPrivateKey, ethSignedMessageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(user1);
        nft.mint(user1, deadline, nonce, signature);
        assertEq(nft.balanceOf(user1), 1);
    }

    function test_setBaseURI_onlyOwner() public {
        string memory newURI = "https://new.uri/";

        vm.prank(user1);
        vm.expectRevert();
        nft.setBaseURI(newURI);

        nft.setBaseURI(newURI);
        assertEq(nft.baseURI(), newURI);
    }

    function test_setBaseURI_emitsEvent() public {
        string memory newURI = "https://new.uri/";

        vm.expectEmit(false, false, false, true);
        emit BaseURIUpdated(BASE_URI, newURI);
        nft.setBaseURI(newURI);
    }

    // ============ Token URI Tests ============

    function test_tokenURI_returnsCorrectURI() public {
        (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignature(user1);
        vm.prank(user1);
        nft.mint(user1, deadline, nonce, sig);

        uint256 tokenId = _findTokenIdOwnedBy(user1);
        string memory expectedURI = string(abi.encodePacked(BASE_URI, vm.toString(tokenId)));
        assertEq(nft.tokenURI(tokenId), expectedURI);
    }

    function test_tokenURI_updatesWithBaseURI() public {
        (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignature(user1);
        vm.prank(user1);
        nft.mint(user1, deadline, nonce, sig);

        uint256 tokenId = _findTokenIdOwnedBy(user1);

        string memory newURI = "https://new.uri/";
        nft.setBaseURI(newURI);

        string memory expectedURI = string(abi.encodePacked(newURI, vm.toString(tokenId)));
        assertEq(nft.tokenURI(tokenId), expectedURI);
    }

    // ============ Ownership Transfer Tests ============

    function test_transfer_ownerCanTransfer() public {
        (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignature(user1);
        vm.prank(user1);
        nft.mint(user1, deadline, nonce, sig);

        uint256 tokenId = _findTokenIdOwnedBy(user1);

        vm.prank(user1);
        nft.transferFrom(user1, user2, tokenId);

        assertEq(nft.ownerOf(tokenId), user2);
        assertEq(nft.balanceOf(user1), 0);
        assertEq(nft.balanceOf(user2), 1);
    }

    function test_transfer_hasMintedRemainsTrue() public {
        (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignature(user1);
        vm.prank(user1);
        nft.mint(user1, deadline, nonce, sig);

        uint256 tokenId = _findTokenIdOwnedBy(user1);

        vm.prank(user1);
        nft.transferFrom(user1, user2, tokenId);

        // user1 still can't mint even after transferring
        assertTrue(nft.hasMinted(user1));
    }

    // ============ View Function Tests ============

    function test_isNonceUsed_returnsFalseForUnusedNonce() public view {
        bytes32 nonce = bytes32(uint256(12345));
        assertFalse(nft.isNonceUsed(nonce));
    }

    function test_isNonceUsed_returnsTrueAfterMint() public {
        (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignature(user1);
        vm.prank(user1);
        nft.mint(user1, deadline, nonce, sig);
        assertTrue(nft.isNonceUsed(nonce));
    }

    // ============ Fuzz Tests ============

    function testFuzz_mint_validDeadline(uint256 futureTime) public {
        // Bound to reasonable future time (1 second to 1 year)
        futureTime = bound(futureTime, 1, 365 days);
        uint256 deadline = block.timestamp + futureTime;

        (bytes32 nonce, , bytes memory sig) = _createSignature(user1);
        // Re-sign with fuzzed deadline
        sig = _sign(user1, deadline, nonce);

        vm.prank(user1);
        nft.mint(user1, deadline, nonce, sig);
        assertEq(nft.balanceOf(user1), 1);
    }

    function testFuzz_mint_anyNonceWorks(bytes32 randomNonce) public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(user1, deadline, randomNonce);

        vm.prank(user1);
        nft.mint(user1, deadline, randomNonce, sig);
        assertEq(nft.balanceOf(user1), 1);
        assertTrue(nft.isNonceUsed(randomNonce));
    }

    // ============ Invariant: totalMinted + availableSupply = MAX_SUPPLY ============

    function test_invariant_supplyConservation() public {
        // Initial state
        assertEq(nft.totalMinted() + nft.availableSupply(), nft.MAX_SUPPLY());

        // After some mints
        for (uint256 i = 0; i < 10; i++) {
            address minter = address(uint160(100 + i));
            vm.deal(minter, 1 ether);
            (bytes32 nonce, uint256 deadline, bytes memory sig) = _createSignatureWithNonce(
                minter,
                bytes32(i)
            );
            vm.prank(minter);
            nft.mint(minter, deadline, nonce, sig);

            assertEq(
                nft.totalMinted() + nft.availableSupply(),
                nft.MAX_SUPPLY(),
                "Supply conservation violated"
            );
        }
    }

    // ============ Helper Functions ============

    function _createSignature(
        address to
    ) internal view returns (bytes32 nonce, uint256 deadline, bytes memory signature) {
        nonce = keccak256(abi.encodePacked(to, block.timestamp));
        deadline = block.timestamp + DEFAULT_DEADLINE;
        signature = _sign(to, deadline, nonce);
    }

    function _createSignatureWithNonce(
        address to,
        bytes32 _nonce
    ) internal view returns (bytes32 nonce, uint256 deadline, bytes memory signature) {
        nonce = _nonce;
        deadline = block.timestamp + DEFAULT_DEADLINE;
        signature = _sign(to, deadline, nonce);
    }

    function _sign(
        address to,
        uint256 deadline,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(to, deadline, nonce, block.chainid, address(nft))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPrivateKey, ethSignedMessageHash);
        return abi.encodePacked(r, s, v);
    }

    function _findTokenIdOwnedBy(address targetOwner) internal view returns (uint256) {
        for (uint256 i = 1; i <= 100; i++) {
            try nft.ownerOf(i) returns (address tokenOwner) {
                if (tokenOwner == targetOwner) {
                    return i;
                }
            } catch {
                // Token doesn't exist yet, continue
            }
        }
        revert("Token not found for owner");
    }
}

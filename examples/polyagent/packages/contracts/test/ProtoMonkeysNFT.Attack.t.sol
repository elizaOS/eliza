// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Test.sol";
import "../src/nft/ProtoMonkeysNFT.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title ProtoMonkeysNFT Attack Tests
 * @notice Attempts to exploit vulnerabilities in the ProtoMonkeysNFT contract
 */
contract ProtoMonkeysNFTAttackTest is Test {
    ProtoMonkeysNFT public nft;
    
    address public owner;
    address public signer;
    uint256 public signerPrivateKey;
    address public attacker;
    address public victim;

    string public constant BASE_URI = "https://polyagent.market/api/nft/metadata/";

    function setUp() public {
        owner = address(this);
        signerPrivateKey = 0xA11CE;
        signer = vm.addr(signerPrivateKey);
        attacker = makeAddr("attacker");
        victim = makeAddr("victim");

        vm.deal(attacker, 100 ether);
        vm.deal(victim, 100 ether);

        nft = new ProtoMonkeysNFT(signer, BASE_URI);
    }

    // ============ ATTACK 1: Reentrancy via onERC721Received ============

    function test_attack_reentrancy_blockedByReentrancyGuard() public {
        // Deploy malicious receiver that tries to re-enter
        // We need to prepare signatures for a DIFFERENT address to test ReentrancyGuard
        // (same address would be blocked by hasMinted anyway)
        
        address attacker2 = makeAddr("attacker2");
        uint256 deadline = block.timestamp + 1 hours;
        
        // Create reentrancy attacker that will try to mint for attacker2 during callback
        ReentrancyAttacker attackContract = new ReentrancyAttacker(nft);
        
        // Prepare signatures
        bytes32 nonce1 = bytes32(uint256(1));
        bytes memory sig1 = _sign(address(attackContract), deadline, nonce1);
        
        bytes32 nonce2 = bytes32(uint256(2));
        bytes memory sig2 = _sign(attacker2, deadline, nonce2);

        // Setup the attacker contract with the second signature to use during callback
        attackContract.setReentryParams(attacker2, deadline, nonce2, sig2);

        // The first mint will trigger onERC721Received, which will try to re-enter
        // This should be blocked by ReentrancyGuard
        attackContract.attack(deadline, nonce1, sig1);
        
        // Verify first mint succeeded
        assertEq(nft.balanceOf(address(attackContract)), 1, "First mint should succeed");
        
        // Verify reentry was blocked (attacker2 shouldn't have received NFT during callback)
        assertEq(nft.balanceOf(attacker2), 0, "Reentry should have been blocked");
        
        // The reentry attempt should have been blocked, but contract state is still valid
        assertTrue(attackContract.reentryAttempted(), "Reentry should have been attempted");
        assertTrue(attackContract.reentryFailed(), "Reentry should have failed");
    }

    // ============ ATTACK 2: Signature Replay Cross-Chain ============

    function test_attack_crossChainReplay_fails() public {
        // Create signature on "this" chain
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(victim, deadline, nonce);

        // Mint on this chain first
        vm.prank(victim);
        nft.mint(victim, deadline, nonce, sig);

        // Now simulate a different chain by changing chainid
        // The signature won't work because chainid is embedded
        vm.chainId(999);
        
        // Deploy new contract on "different chain"
        ProtoMonkeysNFT nft2 = new ProtoMonkeysNFT(signer, BASE_URI);
        
        // Try to replay the same signature (should fail - wrong chain)
        vm.prank(attacker);
        vm.expectRevert(ProtoMonkeysNFT.InvalidSignature.selector);
        nft2.mint(victim, deadline, nonce, sig);
    }

    // ============ ATTACK 3: Signature Replay Same Chain Different Contract ============

    function test_attack_crossContractReplay_fails() public {
        // Create signature for original contract
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(victim, deadline, nonce);

        // Deploy another contract
        ProtoMonkeysNFT nft2 = new ProtoMonkeysNFT(signer, BASE_URI);

        // Try to use signature on different contract (should fail)
        vm.prank(attacker);
        vm.expectRevert(ProtoMonkeysNFT.InvalidSignature.selector);
        nft2.mint(victim, deadline, nonce, sig);
    }

    // ============ ATTACK 4: Nonce Reuse Attack ============

    function test_attack_nonceReuse_fails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        
        // Victim mints with nonce
        bytes memory sigVictim = _sign(victim, deadline, nonce);
        vm.prank(victim);
        nft.mint(victim, deadline, nonce, sigVictim);

        // Attacker tries to use same nonce (even with valid signature for themselves)
        bytes memory sigAttacker = _sign(attacker, deadline, nonce);
        vm.prank(attacker);
        vm.expectRevert(ProtoMonkeysNFT.NonceAlreadyUsed.selector);
        nft.mint(attacker, deadline, nonce, sigAttacker);
    }

    // ============ ATTACK 5: Signature Theft / Front-Running ============

    function test_attack_signatureTheft_victimStillGetsNFT() public {
        // Victim has a valid signature
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(victim, deadline, nonce);

        // Attacker front-runs and submits victim's signature
        // But the NFT goes to victim, not attacker!
        vm.prank(attacker);
        nft.mint(victim, deadline, nonce, sig);

        // Victim still gets the NFT
        assertEq(nft.balanceOf(victim), 1);
        assertEq(nft.balanceOf(attacker), 0);

        // Attacker gained nothing, just paid gas
    }

    // ============ ATTACK 6: Signature for Wrong Address ============

    function test_attack_useOthersSignature_fails() public {
        // Get signature meant for victim
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sigForVictim = _sign(victim, deadline, nonce);

        // Attacker tries to use it for themselves
        vm.prank(attacker);
        vm.expectRevert(ProtoMonkeysNFT.InvalidSignature.selector);
        nft.mint(attacker, deadline, nonce, sigForVictim);
    }

    // ============ ATTACK 7: Expired Signature with Time Manipulation ============

    function test_attack_expiredSignatureTimewarp_fails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(victim, deadline, nonce);

        // Fast forward past deadline
        vm.warp(deadline + 1);

        vm.prank(victim);
        vm.expectRevert(ProtoMonkeysNFT.DeadlineExpired.selector);
        nft.mint(victim, deadline, nonce, sig);
    }

    // ============ ATTACK 8: Mint More Than Once ============

    function test_attack_doubleMint_fails() public {
        // First mint
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce1 = bytes32(uint256(1));
        bytes memory sig1 = _sign(attacker, deadline, nonce1);
        
        vm.prank(attacker);
        nft.mint(attacker, deadline, nonce1, sig1);

        // Second mint with different nonce (still fails - hasMinted check)
        bytes32 nonce2 = bytes32(uint256(2));
        bytes memory sig2 = _sign(attacker, deadline, nonce2);

        vm.prank(attacker);
        vm.expectRevert(ProtoMonkeysNFT.AlreadyMinted.selector);
        nft.mint(attacker, deadline, nonce2, sig2);
    }

    // ============ ATTACK 9: Transfer and Mint Again ============

    function test_attack_transferAndMintAgain_fails() public {
        // Attacker mints
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce1 = bytes32(uint256(1));
        bytes memory sig1 = _sign(attacker, deadline, nonce1);
        
        vm.prank(attacker);
        nft.mint(attacker, deadline, nonce1, sig1);

        uint256 tokenId = _findTokenIdOwnedBy(attacker);

        // Attacker transfers NFT to victim
        vm.prank(attacker);
        nft.transferFrom(attacker, victim, tokenId);

        // Attacker tries to mint again (should fail - hasMinted is permanent)
        bytes32 nonce2 = bytes32(uint256(2));
        bytes memory sig2 = _sign(attacker, deadline, nonce2);

        vm.prank(attacker);
        vm.expectRevert(ProtoMonkeysNFT.AlreadyMinted.selector);
        nft.mint(attacker, deadline, nonce2, sig2);
    }

    // ============ ATTACK 10: Signature Malleability ============

    function test_attack_signatureMalleability_fails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        
        // Get valid signature
        bytes32 messageHash = keccak256(
            abi.encodePacked(victim, deadline, nonce, block.chainid, address(nft))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPrivateKey, ethSignedMessageHash);

        // Create malleable signature by flipping s
        // In ECDSA, (r, s) and (r, -s mod n) both valid mathematically
        // But OpenZeppelin ECDSA library rejects high-s values
        bytes32 sFlipped = bytes32(uint256(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141) - uint256(s));
        uint8 vFlipped = v == 27 ? 28 : 27;

        bytes memory malleableSig = abi.encodePacked(r, sFlipped, vFlipped);

        // Original should work
        bytes memory validSig = abi.encodePacked(r, s, v);
        vm.prank(victim);
        nft.mint(victim, deadline, nonce, validSig);

        // Malleable version should fail (different nonce to test)
        bytes32 nonce2 = bytes32(uint256(2));
        bytes32 messageHash2 = keccak256(
            abi.encodePacked(attacker, deadline, nonce2, block.chainid, address(nft))
        );
        bytes32 ethSignedMessageHash2 = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash2)
        );
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(signerPrivateKey, ethSignedMessageHash2);
        
        // Create malleable version
        bytes32 s2Flipped = bytes32(uint256(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141) - uint256(s2));
        uint8 v2Flipped = v2 == 27 ? 28 : 27;
        bytes memory malleableSig2 = abi.encodePacked(r2, s2Flipped, v2Flipped);

        vm.prank(attacker);
        vm.expectRevert(); // OpenZeppelin ECDSA rejects high-s values
        nft.mint(attacker, deadline, nonce2, malleableSig2);
    }

    // ============ ATTACK 11: Zero-Length Signature ============

    function test_attack_emptySignature_fails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory emptySignature = "";

        vm.prank(attacker);
        vm.expectRevert(); // ECDSA.recover reverts on invalid sig length
        nft.mint(attacker, deadline, nonce, emptySignature);
    }

    // ============ ATTACK 12: Invalid Signature Length ============

    function test_attack_wrongSignatureLength_fails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory shortSignature = hex"deadbeef";

        vm.prank(attacker);
        vm.expectRevert(); // ECDSA.recover reverts on invalid sig length
        nft.mint(attacker, deadline, nonce, shortSignature);
    }

    // ============ ATTACK 13: Unauthorized Signer Change ============

    function test_attack_unauthorizedSignerChange_fails() public {
        address maliciousSigner = makeAddr("malicious");

        vm.prank(attacker);
        vm.expectRevert(); // onlyOwner
        nft.setSigner(maliciousSigner);
    }

    // ============ ATTACK 14: Overflow totalMinted ============

    function test_attack_totalMintedOverflow_impossible() public {
        // totalMinted is uint96, max value is 2^96 - 1
        // But we can only mint 100 tokens, so overflow is impossible
        // The `unchecked` block is safe

        // Mint all 100
        for (uint256 i = 0; i < 100; i++) {
            address minter = address(uint160(1000 + i));
            vm.deal(minter, 1 ether);
            uint256 loopDeadline = block.timestamp + 1 hours;
            bytes32 loopNonce = bytes32(i);
            bytes memory loopSig = _sign(minter, loopDeadline, loopNonce);
            vm.prank(minter);
            nft.mint(minter, loopDeadline, loopNonce, loopSig);
        }

        assertEq(nft.totalMinted(), 100);
        assertEq(nft.availableSupply(), 0);

        // Cannot mint more
        address extraMinter = makeAddr("extra");
        uint256 extraDeadline = block.timestamp + 1 hours;
        bytes32 extraNonce = bytes32(uint256(999));
        bytes memory extraSig = _sign(extraMinter, extraDeadline, extraNonce);
        
        vm.prank(extraMinter);
        vm.expectRevert(ProtoMonkeysNFT.SoldOut.selector);
        nft.mint(extraMinter, extraDeadline, extraNonce, extraSig);
    }

    // ============ ATTACK 15: Mint to Contract Without Receiver ============

    function test_attack_mintToNonReceiverContract_fails() public {
        // Deploy contract that doesn't implement IERC721Receiver
        NonReceiverContract nonReceiver = new NonReceiverContract();
        
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(address(nonReceiver), deadline, nonce);

        vm.expectRevert(); // _safeMint requires receiver implementation
        nft.mint(address(nonReceiver), deadline, nonce, sig);
    }

    // ============ ATTACK 16: Gas Griefing in onERC721Received ============

    function test_attack_gasGriefing_limited() public {
        // Deploy contract that consumes lots of gas in onERC721Received
        GasGriefingReceiver griefingContract = new GasGriefingReceiver();
        
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(address(griefingContract), deadline, nonce);

        // This will succeed but consume extra gas
        // The caller pays the gas, not the contract
        uint256 gasBefore = gasleft();
        nft.mint(address(griefingContract), deadline, nonce, sig);
        uint256 gasUsed = gasBefore - gasleft();
        
        // Gas griefing successful but doesn't break anything
        // The NFT is still minted
        assertEq(nft.balanceOf(address(griefingContract)), 1);
        emit log_named_uint("Gas used with griefing receiver", gasUsed);
    }

    // ============ ATTACK 17: Predict Token ID ============
    
    function test_attack_predictTokenId_possible() public {
        // This demonstrates the weak PRNG - token ID CAN be predicted
        // But it doesn't matter because all tokens are equal value
        
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(1));
        
        // Calculate what the token ID will be using the contract's entropy formula
        uint256 availableLength = nft.availableSupply();
        uint256 predictedIndex = uint256(
            keccak256(
                abi.encodePacked(
                    block.prevrandao,
                    attacker,
                    nft.totalMinted()
                )
            )
        ) % availableLength;
        
        // Token IDs are 1-100, so predictedIndex maps to _availableTokenIds[predictedIndex]
        // Initially _availableTokenIds = [1, 2, 3, ..., 100]
        // So predictedTokenId = predictedIndex + 1 (for first mint)
        uint256 predictedTokenId = predictedIndex + 1;
        
        bytes memory sig = _sign(attacker, deadline, nonce);
        vm.prank(attacker);
        nft.mint(attacker, deadline, nonce, sig);

        uint256 actualTokenId = _findTokenIdOwnedBy(attacker);
        
        // Prediction matches!
        assertEq(actualTokenId, predictedTokenId, "Token ID was predictable");
        emit log_named_uint("Predicted token ID", predictedTokenId);
        emit log_named_uint("Actual token ID", actualTokenId);
    }

    // ============ Helper Functions ============

    function _sign(address to, uint256 deadline, bytes32 nonce) internal view returns (bytes memory) {
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
                if (tokenOwner == targetOwner) return i;
            } catch {}
        }
        revert("Token not found");
    }
}

// ============ Attack Helper Contracts ============

contract ReentrancyAttacker is IERC721Receiver {
    ProtoMonkeysNFT public nft;
    
    // Prepared reentry parameters
    address public reentryTo;
    uint256 public reentryDeadline;
    bytes32 public reentryNonce;
    bytes public reentrySig;
    
    bool public reentryAttempted;
    bool public reentryFailed;

    constructor(ProtoMonkeysNFT _nft) {
        nft = _nft;
    }

    function setReentryParams(
        address _to,
        uint256 _deadline,
        bytes32 _nonce,
        bytes memory _sig
    ) external {
        reentryTo = _to;
        reentryDeadline = _deadline;
        reentryNonce = _nonce;
        reentrySig = _sig;
    }

    function attack(uint256 deadline, bytes32 nonce, bytes memory sig) external {
        nft.mint(address(this), deadline, nonce, sig);
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        // Only attempt reentry once
        if (!reentryAttempted && reentryTo != address(0)) {
            reentryAttempted = true;
            
            // Try to re-enter mint with prepared parameters
            try nft.mint(reentryTo, reentryDeadline, reentryNonce, reentrySig) {
                // If we get here, reentry succeeded (BAD!)
                reentryFailed = false;
            } catch {
                // Reentry was blocked (GOOD!)
                reentryFailed = true;
            }
        }
        
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract NonReceiverContract {
    // Deliberately doesn't implement IERC721Receiver
}

contract GasGriefingReceiver is IERC721Receiver {
    uint256 public waste;

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        // Waste gas by doing expensive operations
        for (uint256 i = 0; i < 100; i++) {
            waste = uint256(keccak256(abi.encodePacked(waste, i)));
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

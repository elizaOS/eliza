// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "../src/nft/ProtoMonkeysNFT.sol";

/**
 * @title DeployProtoMonkeysNFT
 * @notice Deployment script for ProtoMonkeysNFT contract on Ethereum
 * @dev
 * Deploy to Sepolia testnet:
 *   forge script script/DeployProtoMonkeysNFT.s.sol:DeployProtoMonkeysNFT \
 *     --rpc-url https://rpc.sepolia.org --broadcast --verify
 *
 * Deploy to Ethereum mainnet:
 *   forge script script/DeployProtoMonkeysNFT.s.sol:DeployProtoMonkeysNFT \
 *     --rpc-url https://eth.llamarpc.com --broadcast --verify
 *
 * Required environment variables:
 * - NFT_SIGNER_ADDRESS: Address authorized to sign mint messages
 * - NFT_BASE_URI: Base URI for token metadata (e.g., https://polyagent.market/api/nft/metadata/)
 *
 * Optional:
 * - PRIVATE_KEY: Deployer's private key (if not using hardware wallet)
 */
contract DeployProtoMonkeysNFT is Script {
    function run() external {
        // Read required environment variables
        address signerAddress = vm.envAddress("NFT_SIGNER_ADDRESS");
        string memory baseURI = vm.envString("NFT_BASE_URI");

        // Validate inputs
        require(signerAddress != address(0), "NFT_SIGNER_ADDRESS cannot be zero");
        require(bytes(baseURI).length > 0, "NFT_BASE_URI cannot be empty");

        // Log deployment info
        console.log("=== ProtoMonkeysNFT Deployment ===");
        console.log("Chain ID:", block.chainid);
        console.log("Signer:", signerAddress);
        console.log("Base URI:", baseURI);
        console.log("Deployer:", msg.sender);
        console.log("");

        // Start broadcast
        vm.startBroadcast();

        // Deploy the contract
        ProtoMonkeysNFT nft = new ProtoMonkeysNFT(signerAddress, baseURI);

        vm.stopBroadcast();

        // Log results
        console.log("=== Deployment Complete ===");
        console.log("ProtoMonkeysNFT deployed to:", address(nft));
        console.log("");
        console.log("Contract Configuration:");
        console.log("  - Name:", nft.name());
        console.log("  - Symbol:", nft.symbol());
        console.log("  - Max Supply:", nft.MAX_SUPPLY());
        console.log("  - Signer:", nft.signer());
        console.log("  - Owner:", nft.owner());
        console.log("");
        console.log("Add this address to your environment:");
        console.log("  NFT_CONTRACT_ADDRESS=", address(nft));
    }
}

/**
 * @title DeployProtoMonkeysNFTLocal
 * @notice Local deployment script with default values for testing
 * @dev Run with: forge script script/DeployProtoMonkeysNFT.s.sol:DeployProtoMonkeysNFTLocal --rpc-url http://localhost:8545 --broadcast
 */
contract DeployProtoMonkeysNFTLocal is Script {
    // Default Anvil Account #0 (test test test... junk)
    address constant DEFAULT_SIGNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    string constant DEFAULT_BASE_URI = "http://localhost:3000/api/nft/metadata/";

    function run() external {
        // Use environment if set, otherwise use defaults
        address signerAddress = vm.envOr("NFT_SIGNER_ADDRESS", DEFAULT_SIGNER);
        string memory baseURI = vm.envOr("NFT_BASE_URI", DEFAULT_BASE_URI);

        console.log("=== ProtoMonkeysNFT Local Deployment ===");
        console.log("Chain ID:", block.chainid);
        console.log("Signer:", signerAddress);
        console.log("Base URI:", baseURI);
        console.log("");

        vm.startBroadcast();

        ProtoMonkeysNFT nft = new ProtoMonkeysNFT(signerAddress, baseURI);

        vm.stopBroadcast();

        console.log("=== Deployment Complete ===");
        console.log("ProtoMonkeysNFT deployed to:", address(nft));
        console.log("NFT_CONTRACT_ADDRESS=", address(nft));
    }
}

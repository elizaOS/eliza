# @elizaos/plugin-nft-generation

NFT collection generation plugin for Eliza OS that enables NFT creation, collection management, and verification on the Solana blockchain.

## Overview

This plugin provides comprehensive NFT functionality, including collection creation, NFT minting, and verification, with automatic image generation and metadata management.

## Features

- Automated NFT collection creation
- AI-powered image generation for NFTs
- Collection logo generation
- Metadata creation and management
- AWS S3 integration for asset storage
- Solana blockchain integration
- NFT verification system
- Automatic nonce management
- Comprehensive error handling

## Installation

```bash
pnpm install @elizaos/plugin-nft-generation
```

## Configuration

The plugin requires environment variables or runtime settings:

```env
# Solana Configuration
SOLANA_PUBLIC_KEY=your-wallet-public-key
SOLANA_PRIVATE_KEY=your-wallet-private-key
SOLANA_ADMIN_PUBLIC_KEY=admin-public-key
SOLANA_ADMIN_PRIVATE_KEY=admin-private-key
SOLANA_VERIFY_TOKEN=verification-token
SOLANA_CLUSTER=devnet  # or mainnet-beta

# AWS Configuration
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_REGION=aws-region
AWS_S3_BUCKET=bucket-name
```

## API Reference

### Collection Management

#### `createCollection`

Creates a new NFT collection with an AI-generated logo.

```typescript
const result = await createCollection({
    runtime: runtimeInstance,
    collectionName: "MyCollection",
    fee: 0.01, // Optional: royalty fee percentage
});
```

#### `createNFT`

Mints a new NFT in an existing collection.

```typescript
const nft = await createNFT({
    runtime: runtimeInstance,
    collectionName: "MyCollection",
    collectionAddress: "collection123",
    collectionAdminPublicKey: "admin123",
    collectionFee: 0.01,
    tokenId: 1,
});
```

#### `verifyNFT`

Verifies an NFT as part of a collection.

```typescript
const verification = await verifyNFT({
    runtime: runtimeInstance,
    collectionAddress: "collection123",
    NFTAddress: "nft123",
});
```

## REST API Endpoints

### POST `/api/nft-generation/create-collection`

Creates a new collection with generated logo.

### POST `/api/nft-generation/create-nft`

Mints a new NFT with generated artwork.

### POST `/api/nft-generation/create-nft-metadata`

Generates metadata for an NFT.

### POST `/api/nft-generation/verify-nft`

Verifies an NFT's collection membership.

## Example Workflow

The plugin provides a streamlined process for generating and verifying NFT collections:

```typescript
import { createCollection, createNFT, verifyNFT } from "./handlers";

const runtime = initializeRuntime(); // Replace with actual IAgentRuntime initialization

(async () => {
    // Step 1: Create Collection
    const collectionResult = await createCollection({
        runtime,
        collectionName: "MyUniqueCollection",
    });

    console.log("Collection created:", collectionResult);

    // Step 2: Create an NFT in the Collection
    const nftResult = await createNFT({
        runtime,
        collectionName: "MyUniqueCollection",
        collectionAddress: collectionResult.address,
        collectionAdminPublicKey:
            collectionResult.collectionInfo.adminPublicKey,
        collectionFee: 0.01,
        tokenId: 1,
    });

    console.log("NFT created:", nftResult);

    // Step 3: Verify the NFT
    const verificationResult = await verifyNFT({
        runtime,
        collectionAddress: collectionResult.address,
        NFTAddress: nftResult.address,
    });
    console.log("NFT verified:", verificationResult);
})();
```

## Example Prompts

Here are some examples of user prompts to trigger NFT collection generation:

- "Generate a collection named MyCollection."
- "Create a new NFT collection."
- "Compile an NFT collection for me."
- "Build a sci-fi themed collection."

## Local Testing with TEE Simulator

To test locally using a Trusted Execution Environment (TEE) simulator:

1. Pull the simulator Docker image:

```bash
docker pull phalanetwork/tappd-simulator:latest
```

2. Run the simulator:

```bash
docker run --rm -p 8090:8090 phalanetwork/tappd-simulator:latest
```

3. Update your environment variable for the simulator:

```env
DSTACK_SIMULATOR_ENDPOINT="http://localhost:8090"
```

## Security Best Practices

1. **Key Management**

    - Store private keys securely
    - Use environment variables
    - Implement key rotation
    - Monitor wallet activity

2. **Asset Security**

    - Secure S3 bucket configuration
    - Implement proper CORS policies
    - Use secure URLs for metadata
    - Regular backup of assets

3. **Transaction Safety**

    - Validate all inputs
    - Implement fee limits
    - Double-check collection ownership
    - Monitor transaction status

4. **Error Handling**
    - Log all operations
    - Handle timeouts gracefully
    - Validate metadata
    - Provide clear error messages

## Dependencies

- @elizaos/core: workspace:\*
- @elizaos/plugin-image-generation: workspace:\*
- @elizaos/plugin-node: workspace:\*
- @metaplex-foundation/mpl-token-metadata: ^3.3.0
- @solana/web3.js: 1.95.5
- express: 4.21.1
- node-cache: 5.1.2

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with:

- [Solana Blockchain](https://solana.com)
- [Metaplex Protocol](https://www.metaplex.com)
- AWS S3 for asset storage

Special thanks to:

- The Solana ecosystem and all the open-source contributors who make these integrations possible.
- The Eliza community for their contributions and feedback.

For more information about Solana blockchain capabilities:

- [Solana Documentation](https://docs.solana.com/)
- [Solana Developer Portal](https://solana.com/developers)
- [Solana Network Dashboard](https://solscan.io/)
- [Solana GitHub Repository](https://github.com/solana-labs/solana)

## License

This plugin is part of the Eliza project. See the main project repository for license information.

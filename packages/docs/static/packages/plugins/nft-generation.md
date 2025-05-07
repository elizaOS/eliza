# @elizaos/plugin-nft-generation

## Purpose

NFT collection generation plugin for Eliza OS that enables NFT creation, collection management, and verification on the Solana blockchain.

## Key Features

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
bun install @elizaos/plugin-nft-generation
```

## Configuration

Requires environment variables for:

- Solana Configuration (keys, cluster settings)
- AWS Configuration (access keys, region, bucket)

## Integration

Provides REST API endpoints for NFT operations and exposes handlers for collection creation, NFT minting, and verification that integrate with ElizaOS runtime.

## Example Usage

```typescript
import { createCollection, createNFT, verifyNFT } from './handlers';

const runtime = initializeRuntime();

(async () => {
  // Step 1: Create Collection
  const collectionResult = await createCollection({
    runtime,
    collectionName: 'MyUniqueCollection',
  });

  // Step 2: Create an NFT in the Collection
  const nftResult = await createNFT({
    runtime,
    collectionName: 'MyUniqueCollection',
    collectionAddress: collectionResult.address,
    collectionAdminPublicKey: collectionResult.collectionInfo.adminPublicKey,
    collectionFee: 0.01,
    tokenId: 1,
  });

  // Step 3: Verify the NFT
  const verificationResult = await verifyNFT({
    runtime,
    collectionAddress: collectionResult.address,
    NFTAddress: nftResult.address,
  });
})();
```

## Links

- [Solana Documentation](https://docs.solana.com/)
- [Solana Developer Portal](https://solana.com/developers)
- [Solana Network Dashboard](https://solscan.io/)
- [Solana GitHub Repository](https://github.com/solana-labs/solana)

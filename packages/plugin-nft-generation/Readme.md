### NFT Collection Generation Plugin
A plugin for handling NFT collection generation, NFT creation, anNFT Collection Generation Plugin
A plugin for handling NFT collection generation, NFT creation, and verification on the Solana blockchain.

## Handlers
### createCollection
The createCollection handler generates an NFT collection logo, uploads it to AWS S3, and creates a Solana blockchain collection.

#### Usage
```typescript
import { createCollection } from "./handlers/createCollection.ts";

const result = await createCollection({
    runtime: runtimeInstance, // An instance of IAgentRuntime
    collectionName: "MyCollection", // The name of the collection
    fee: 0.01, // (Optional) Fee for transactions
});

console.log("Collection created:", result);
```
#### Features
Image Generation: Automatically generates a collection logo based on the provided name and theme.
AWS S3 Integration: Uploads the generated logo and metadata to AWS S3.
Solana Blockchain: Creates a collection with the generated logo and metadata on the Solana blockchain.
### createNFT
The createNFT handler generates individual NFTs for a collection. It includes metadata creation and uploads the NFT information to AWS S3.

#### Usage
```typescript
import { createNFT } from "./handlers/createNFT.ts";

const nftResult = await createNFT({
    runtime: runtimeInstance,
    collectionName: "MyCollection",
    collectionAddress: "collectionAddress123",
    collectionAdminPublicKey: "adminPublicKey123",
    collectionFee: 0.01,
    tokenId: 1,
});

console.log("NFT created:", nftResult);
```

### verifyNFT
The verifyNFT handler verifies an NFT against its collection using the Solana blockchain.

#### Usage
```typescript
import { verifyNFT } from "./handlers/verifyNFT.ts";

const verificationResult = await verifyNFT({
    runtime: runtimeInstance,
    collectionAddress: "collectionAddress123",
    NFTAddress: "NFTAddress123",
});

console.log("NFT verified:", verificationResult);
````
---

### Example Workflow
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
        collectionAdminPublicKey: collectionResult.collectionInfo.adminPublicKey,
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

### Configuration

#### Environment Variables
```
Ensure the following environment variables are set for proper functionality:

Variable Name	Description
AWS_ACCESS_KEY_ID	AWS access key for S3 uploads
AWS_SECRET_ACCESS_KEY	AWS secret key for S3 uploads
AWS_REGION	AWS region where S3 is located
AWS_S3_BUCKET	Name of the AWS S3 bucket
SOLANA_PUBLIC_KEY	Public key for Solana blockchain
SOLANA_PRIVATE_KEY	Private key for Solana blockchain
SOLANA_ADMIN_PUBLIC_KEY	Admin public key for Solana operations
SOLANA_ADMIN_PRIVATE_KEY	Admin private key for Solana operations
```
#### Example Prompts
Here are some examples of user prompts to trigger NFT collection generation:

"Generate a collection named MyCollection."
"Create a new NFT collection."
"Compile an NFT collection for me."
"Build a sci-fi themed collection."


#### Local Testing with TEE Simulator
To test locally using a Trusted Execution Environment (TEE) simulator, follow these steps:

Pull the simulator Docker image:
``` bash
docker pull phalanetwork/tappd-simulator:latest
```
Run the simulator:

``` bash
docker run --rm -p 8090:8090 phalanetwork/tappd-simulator:latest
```
Update your environment variable for the simulator:

```env
DSTACK_SIMULATOR_ENDPOINT="http://localhost:8090"
```

#### Dependencies
This plugin relies on the following services and libraries:

[@ai16z/plugin-node]
[@ai16z/eliza]
[@ai16z/plugin-image-generation]
[@solana/web3.js]
### Action Configuration
#### GENERATE_COLLECTION
The action for generating NFT collections is configured with the following parameters:

```typescript
const nftCollectionGeneration: Action = {
    name: "GENERATE_COLLECTION",
    description: "Generate an NFT collection for the message",
    handler: async (runtime, message, state, options, callback) => {
        // Implementation
    },
    examples: [
        {
            user: "{{user1}}",
            content: { text: "Generate a collection named Galaxy." },
        },
        {
            agent: "{{agentName}}",
            content: { text: "The collection Galaxy has been successfully created." },
        },
    ],
};
```

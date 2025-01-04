# @elizaos/plugin-irys

A plugin for ElizaOS that enables decentralized data storage and retrieval using Irys, a programmable datachain platform.

## Overview

This plugin integrates Irys functionality into ElizaOS, allowing agents to store and retrieve data in a decentralized manner. It provides a robust service for creating a decentralized knowledge base and enabling multi-agent collaboration.

## Installation

To install this plugin, run the following command:

```bash
pnpm add @elizaos/plugin-irys
```


## Features

- **Decentralized Data Storage**: Store data permanently on the Irys network
- **Data Retrieval**: Fetch stored data using GraphQL queries
- **Multi-Agent Support**: Enable data sharing and collaboration between agents
- **Ethereum Integration**: Built-in support for Ethereum wallet authentication

## Configuration

The plugin requires the following environment variables:

- `EVM_WALLET_PRIVATE_KEY`: Your EVM wallet private key
- `AGENTS_WALLET_PUBLIC_KEYS`: The public keys of the agents that will be used to retrieve the data (string separated by commas)

For this plugin to work, you need to have an EVM (Base network) wallet with a private key and public address. To prevent any security issues, we recommend using a dedicated wallet for this plugin.

> **Important**: The wallet address needs to have Base Sepolia ETH tokens to store images/files and any data larger than 100KB.

## Usage

### Uploading Data

To upload data to the Irys network, you can use the `uploadDataOnIrys` function. This function will upload the data to the Irys network and return the transaction hash.

```typescript
const { IrysService } = require('@elizaos/plugin-irys');

const irysService : IrysService = runtime.getService(ServiceType.IRYS)
const data = "Hello, world!";
const transactionResult = await irysService.uploadDataOnIrys(data);
console.log(`Data uploaded successfully. Transaction hash: ${transactionResult}`);
```

To upload files or images to the Irys network, you can use the `uploadFileOrImageOnIrys` function:

```typescript
const { IrysService } = require('@elizaos/plugin-irys');

const irysService : IrysService = runtime.getService(ServiceType.IRYS)
const userAttachmentToStore = state.recentMessagesData[1].content.attachments[0].url.replace("agent\\agent", "agent");
            
const transactionResult = await irysService.uploadFileOrImageOnIrys(userAttachmentToStore);
console.log(`Data uploaded successfully. Transaction hash: ${transactionResult}`);
```

### Retrieving Data

To retrieve data from the Irys network, you can use the `getDataFromAnAgent` function. This function will retrieve all data associated with the given wallet addresses. The function automatically detects the content type and returns either JSON data or file URLs accordingly.

- For files and images: Returns the URL of the stored content
- For other data types: Returns a JSON object with the following structure:
```typescript
{
  data: string,    // The stored data
  timestamp: Date  // When the data was stored
}
```

```typescript
const { IrysService } = require('@elizaos/plugin-irys');

const irysService = runtime.getService(ServiceType.IRYS)
const agentsWalletPublicKeys = runtime.getSetting("AGENTS_WALLET_PUBLIC_KEYS").split(",");
const data = await irysService.getDataFromAnAgent(agentsWalletPublicKeys);
console.log(`Data retrieved successfully. Data: ${data}`);
```

## About Irys

Irys is the first Layer 1 (L1) programmable datachain designed to optimize both data storage and execution. By integrating storage and execution, Irys enhances the utility of blockspace, enabling a broader spectrum of web services to operate on-chain.

### Key Features of Irys

- **Unified Platform**: Combines data storage and execution, allowing developers to eliminate dependencies and integrate efficient on-chain data seamlessly.
- **Cost-Effective Storage**: Optimized specifically for data storage, making it significantly cheaper to store data on-chain compared to traditional blockchains.
- **Programmable Datachain**: The IrysVM can utilize on-chain data during computations, enabling dynamic and real-time applications.
- **Decentralization**: Designed to minimize centralization risks by distributing control.
- **Free Storage for Small Data**: Storing less than 100KB of data is free.
- **GraphQL Querying**: Metadata stored on Irys can be queried using GraphQL.

### GraphQL Query Examples

The plugin uses GraphQL to retrieve transaction metadata. Here's an example query structure:

```graphql
query {
  transactions(owners: ["0x1234567890", "0x0987654321"]) {
    edges {
      node {
        id
      }
    }
  }
}
```


## API Reference

### IrysService

The main service provided by this plugin implements the following interface:

```typescript
interface IrysService {
    uploadStringToIrys(data: string): Promise<string>;
    getDataFromAnAgent(agentsWalletPublicKeys: string[]): Promise<string>;
}
```

#### Methods

- `uploadStringToIrys(data: string)`: Uploads a string to Irys and returns the transaction URL
- `getDataFromAnAgent(agentsWalletPublicKeys: string[])`: Retrieves all data associated with the given wallet addresses

## Testing

While we don't currently have a formal test suite, all functions have been manually tested through agent actions to verify their functionality. Each function has been validated in real-world scenarios to ensure reliable performance.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
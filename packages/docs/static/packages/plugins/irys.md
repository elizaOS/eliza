# @elizaos/plugin-irys

## Purpose

A plugin for ElizaOS that enables decentralized data storage and retrieval using Irys, a programmable datachain platform.

## Key Features

- Decentralized Data Storage: Store data permanently on the Irys network
- Data Retrieval: Fetch stored data using GraphQL queries
- Multi-Agent Support: Enable data sharing and collaboration between agents
- Ethereum Integration: Built-in support for Ethereum wallet authentication

## Installation

```bash
bun add @elizaos/plugin-irys
```

## Configuration

Required environment variables:

- `EVM_WALLET_PRIVATE_KEY`: Your EVM wallet private key
- `AGENTS_WALLET_PUBLIC_KEYS`: Public keys of agents to retrieve data (comma-separated)

An EVM (Base network) wallet with Base Sepolia ETH tokens is required for storing data larger than 100KB.

## Integration

The plugin provides an IrysService with methods for workers and providers to store and retrieve data on the Irys network. It enables decentralized knowledge base creation and multi-agent collaboration through a system of Providers, Orchestrators, and Workers.

## Example Usage

```typescript
const { IrysService } = require('@elizaos/plugin-irys');

const irysService = runtime.getService(ServiceType.IRYS);
const data = 'Provide Liquidity to the ETH pool on Stargate';
const result = await irysService.workerUploadDataOnIrys(
  data,
  IrysDataType.OTHER,
  IrysMessageType.DATA_STORAGE,
  ['DeFi'],
  ['Stargate', 'LayerZero']
);
```

## Links

- [Irys Documentation](https://docs.irys.xyz/)
- [A Decentralized Framework for Multi-Agent Systems Using Datachain Technology](https://trophe.net/article/A_Decentralized_Framework_for_Multi-Agent_Systems_Using_Datachain_Technology.pdf)

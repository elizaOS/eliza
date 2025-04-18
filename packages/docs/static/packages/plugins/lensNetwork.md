# @elizaos/plugin-abstract

## Purpose

A plugin for interacting with the Abstract blockchain network within the ElizaOS ecosystem, enabling seamless token transfers on the Abstract testnet.

## Installation

```bash
bun install @elizaos/plugin-lensNetwork
```

## Configuration

The plugin requires the following environment variables:

```typescript
LENS_ADDRESS=<Your Lens wallet address>
LENS_PRIVATE_KEY=<Your Lens private key>
```

## Integration

The plugin integrates with ElizaOS to handle natural language commands for token transfers like "Send 1 Grass to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62".

## Example Usage

```typescript
import { lensPlugin } from '@elizaos/plugin-lensNetwork';
```

# @elizaos/plugin-conflux

## Purpose

A plugin for interacting with the Conflux blockchain network within the ElizaOS ecosystem, enabling seamless interaction with both Conflux Core Space and eSpace networks.

## Key Features

- Token transfers in Conflux Core Space
- Cross-space bridge operations
- ConfiPump token management (creation, buying, and selling)

## Installation

```bash
bun install @elizaos/plugin-conflux
```

## Configuration

The plugin requires these environment variables:

```typescript
CONFLUX_CORE_PRIVATE_KEY=<Your Conflux Core Space private key>
CONFLUX_CORE_SPACE_RPC_URL=<Conflux Core Space RPC endpoint>
CONFLUX_MEME_CONTRACT_ADDRESS=<ConfiPump contract address>
```

## Integration

```typescript
import { confluxPlugin } from '@elizaos/plugin-conflux';
```

## Example Usage

```typescript
// Core Space Transfer
'Send 1 CFX to cfx:aaejuaaaaaaaaaaaaaaaaaaaaaaaaaaaa2eaeg85p5';

// Cross-Space Bridge Transfer
'Send 1 CFX to eSpace Address 0x119DA8bbe74B1C5c987D0c64D10eC1dB301d4752';

// ConfiPump Token Creation
'Create a new token called GLITCHIZA with symbol GLITCHIZA and generate a description about it';

// ConfiPump Token Trading
'Buy 0.00069 CFX worth of GLITCHIZA(0x1234567890abcdef)';
'Sell 0.00069 CFX worth of GLITCHIZA(0x1234567890abcdef)';
```

## Links

- [Conflux Documentation](https://developer.confluxnetwork.org/)
- [Conflux Portal](https://portal.confluxnetwork.org/)
- [ConfluxScan](https://confluxscan.io/)
- [Cross-Space Bridge](https://bridge.confluxnetwork.org/)

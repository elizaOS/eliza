# @elizaos/plugin-cronoszkevm

## Purpose

A plugin for interacting with the Cronos zkEVM network within the ElizaOS ecosystem, enabling seamless token transfers including ZKCRO, USDC, and ETH.

## Installation

```bash
bun install @elizaos/plugin-cronoszkevm
```

## Configuration

Requires environment variables:

```typescript
CRONOSZKEVM_ADDRESS=<Your Cronos zkEVM wallet address>
CRONOSZKEVM_PRIVATE_KEY=<Your Cronos zkEVM private key>
```

## Integration

```typescript
import { cronosZkEVMPlugin } from '@elizaos/plugin-cronoszkevm';
```

## Example Usage

```typescript
// Send USDC tokens
'Send 100 USDC to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62';

// Send ZKCRO tokens
'Send 100 ZKCRO to 0xbD8679cf79137042214fA4239b02F4022208EE82';

// Send ETH tokens
'Transfer 1 ETH to 0x123...';
```

## Links

- [Cronos zkEVM Documentation](https://docs.cronos.org/zkevm/)
- [zkEVM Bridge](https://zkevm.cronos.org/bridge)
- [Cronos Developer Portal](https://cronos.org/developers)
- [zkSync Integration Guide](https://docs.cronos.org/zkevm/integration)

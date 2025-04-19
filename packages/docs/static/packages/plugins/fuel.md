# @elizaos/plugin-fuel

## Purpose

A plugin for interacting with the Fuel blockchain within the ElizaOS ecosystem, focusing on ETH transfers on the Fuel Ignition network.

## Installation

```bash
bun install @elizaos/plugin-fuel
```

## Configuration

```typescript
FUEL_PRIVATE_KEY=<Private key for the Fuel wallet starting with 0x>
FUEL_PROVIDER_URL=<Custom RPC endpoint URL (optional, defaults to "https://mainnet.fuel.network/v1/graphql")>
```

## Integration

Import the plugin:

```typescript
import { fuelPlugin } from '@elizaos/plugin-fuel';
```

## Example Usage

```typescript
'Transfer 1 ETH to 0x8F8afB12402C9a4bD9678Bec363E51360142f8443FB171655eEd55dB298828D1';
```

## Links

- [Fuel Documentation](https://docs.fuel.network/)
- [Fuel Developer Portal](https://developers.fuel.network/)
- [Fuel Network Dashboard](https://app.fuel.network/)
- [Fuel GitHub Repository](https://github.com/FuelLabs)

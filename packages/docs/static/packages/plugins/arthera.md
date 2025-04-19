# @elizaos/plugin-arthera

## Purpose

This plugin provides actions and providers for interacting with Arthera.

## Configuration

### Default Setup

By default, Arthera is enabled. Add your private key to the .env file:

```env
ARTHERA_PRIVATE_KEY=your-private-key-here
```

### Custom RPC URLs

To use a custom RPC URL for a specific chain:

```env
ETHEREUM_PROVIDER_<CHAIN_NAME>=https://your-custom-rpc-url
```

Example:

```env
ETHEREUM_PROVIDER_ARTHERA=https://rpc.arthera.net
```

## Integration

The Wallet Provider initializes with Arthera and:

- Provides context of the currently connected address and its balance
- Creates Public and Wallet clients to interact with the supported chain

## Example Usage

```bash
Transfer 1 AA to 0xRecipient on arthera.
```

## Contribution

The plugin contains tests. Run tests before submitting a PR:

```bash
bun test
```

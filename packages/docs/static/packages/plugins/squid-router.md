# @elizaos/squid-router

## Purpose

This plugin adds Squid Router functionality to Eliza agents, allowing cross chain swaps between blockchains.

## Configuration

The plugin requires the following configuration:

```
# Squid Router
SQUID_SDK_URL=https://apiplus.squidrouter.com # Default: https://apiplus.squidrouter.com
SQUID_INTEGRATOR_ID= # get integrator id through https://docs.squidrouter.com/
SQUID_EVM_ADDRESS=
SQUID_EVM_PRIVATE_KEY=
```

## Integration

It enables cross chain swaps between blockchains, currently supporting only swaps between EVM chains with plans to add Solana and Cosmos ecosystem in the future.

## Actions

### Cross Chain Swap

name: `X_CHAIN_SWAP`
Perform cross chain swaps for both native and ERC20 tokens supported by Squid Router.
Message sample: `Bridge 1 ETH from Ethereum to Base`

## Links

[Squid Router documentation](https://docs.squidrouter.com/)

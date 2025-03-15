# @elizaos/squid-router

This plugin adds Squid Router functionality to Eliza agents. It allows cross chain swaps between blockchains.
For now, only swaps between EVM chains are supported, but the plan is to add swaps from/to Solana and the Cosomos ecosystem.
For supported chains and tokens, please refer to the [Squid Router documentation](https://docs.squidrouter.com/).

## Configuration

The plugin requires the following configuration:
```
# Squid Router
SQUID_SDK_URL=https://apiplus.squidrouter.com # Default: https://apiplus.squidrouter.com
SQUID_INTEGRATOR_ID= # get integrator id through https://docs.squidrouter.com/
SQUID_EVM_ADDRESS=
SQUID_EVM_PRIVATE_KEY=
```

## Actions

### Cross Chain Swap

name: `X_CHAIN_SWAP`

Perform cross chain swaps for both native and ERC20 tokens supported by Squid Router.

Message sample: `Bridge 1 ETH from Ethereum to Base`

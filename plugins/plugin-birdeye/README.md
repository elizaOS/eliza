# Eliza Birdeye Plugin

A powerful plugin for Eliza that integrates with Birdeye's comprehensive DeFi and token analytics API. This plugin provides real-time access to blockchain data, token metrics, and DeFi analytics across multiple networks.

## Features

### Provider Featurs

- **Agent Portfolio Provider**

    - If `BIRDEYE_WALLET_ADDR` is set, this provider will fetch the wallet's portfolio data from Birdeye and be able to respond to questions related to the wallet's holdings.

### Action Features

- **Token Search Address**

    - This action will search input message for token addresses and when present will query Birdeye for token information

- **Token Search Symbol**

    - This action will search input message for token symbols in the format of `$SYMBOL` and when present will query Birdeye for token information. Note that this action currently only supports SOL, SUI, and ETH addresses.
        - _Any addresses that look like EVM addresses will be treated as ETH addresses since there is no easy way to distinguish between the other EVM chains that are supported by Birdeye_.

- **Wallet Search Address**

    - This action will search input message for wallet addresses and when present will query Birdeye for wallet information

## API Reference

The plugin provides access to a subset of Birdeye API endpoints through structured interfaces. For detailed API documentation, visit [Birdeye's API Documentation](https://public-api.birdeye.so).

## License

See parent project for license information.

## Contributing

Contributions are welcome! See parent project for contribution guidelines.

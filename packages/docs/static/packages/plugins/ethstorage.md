# @elizaos/plugin-ethstorage

## Purpose

This plugin allows interaction with the EthStorage decentralized storage network using Eliza.

## Key Features

- Transfer QKC tokens from agent's wallet to another wallet
- Submit arbitrary data to the EthStorage decentralized storage network

## Configuration

- ETHSTORAGE_ADDRESS: Entry contract address for storing data (default: beta testnet)
- ETHSTORAGE_RPC_URL: RPC endpoint for connecting to desired network (default: beta testnet)
- ETHSTORAGE_PRIVATE_KEY: Private key for the agent's wallet

## Integration

The plugin provides two actions that integrate with ElizaOS:

- SEND_TOKEN: Transfers QKC tokens between wallets
- SUBMIT_DATA: Submits data to EthStorage using a specified key

## Example Usage

- Transfer: "Send 100 QKC to 0x341Cb1a94ef69499F97E93c41707B21326C0Cc87"
- Submit Data: "Submit the following data using key 'my_key' to EthStorage 'Hello World!'"

## Links

- [EthStorage Documentation](https://docs.ethstorage.io/)
- [Learn more about EthStorage](https://ethstorage.io/)
- [Awesome EthStorage Repo](https://github.com/ethstorage/)

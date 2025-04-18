# @elizaos/plugin-avail - Plugin for Avail

## Purpose

A plugin for using Eliza to interact with the Avail DA network. Defaults to Turing testnet, but can be customized to use Mainnet by changing the RPC in the `.env` file.

## Key Features

- Transfer AVAIL tokens from the agent's wallet to another wallet
- Submit arbitrary data to the Avail DA network

## Configuration

- `AVAIL_RPC_URL`: RPC endpoint (defaults to Turing testnet)
- `AVAIL_ADDRESS`: Public address for the agent account
- `AVAIL_SEED`: Seed phrase for the agent account
- `AVAIL_APP_ID`: Customize the Avail appID for data submission

## Example Usage

- Transfer: "Send 100 AVAIL to 5GWbvXjefEvXXETtKQH7YBsUaPc379KAQATW1eqeJT26cbsK"
- Submit data: "Submit the following data to Avail 'Hello World!'"

## Links

- [Avail Documentation](https://docs.availproject.org/)
- [Set up an Avail Account](https://docs.availproject.org/user-guides/accounts#seed-phrases)
- [Network Information](https://docs.availproject.org/docs/networks)
- [Learn about appIDs](https://docs.availproject.org/docs/build-with-avail/interact-with-avail-da/app-id)
- [Learn about Avail](https://www.availproject.org/)
- [Awesome Avail Repo](https://github.com/availproject/awesome-avail)

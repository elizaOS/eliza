# @elizaos/plugin-ethstorage - Plugin for EthStorage

This plugin allows interaction with the EthStorage decentralized storage network using Eliza. By default, it operates on the beta testnet, but you can switch to other testnets by updating the `ETHSTORAGE_RPC_URL` in the `.env` file. The mainnet is not yet available.

## Actions
- **transfer**: This action enables the transfer of QKC tokens from the agent's wallet (specified via `ETHSTORAGE_PRIVATE_KEY`) to another wallet. To use, just mention the transfer of tokens to an EthStorage account.

    - Name: `SEND_TOKEN`

    - Message sample: `Send 100 QKC to 0x341Cb1a94ef69499F97E93c41707B21326C0Cc87`

- **submitData**: This action enables the submission of any arbitrary data to the EthStorage decentralized storage network. To use, just mention that you need to send "any data" to EthStorage using the key you specified.

    - Name: `SUBMIT_DATA`

    - Message sample: `Submit the following data using key 'my_key' to EthStorage "Hello World!"`

## Usage & Testing

### Detailed testing steps
- In the .env file, set the following values:
    - ETHSTORAGE_ADDRESS: The entry contract address for storing data on the EthStorage network (default is set to the beta testnet but can be updated if needed).
    - ETHSTORAGE_RPC_URL: The RPC endpoint for connecting to the desired EthStorage network (default is set to the beta testnet).
    - ETHSTORAGE_PRIVATE_KEY: The private key for the agent’s wallet.
- **Transfer Tokens**
    - To test the transfer function, you need tokens in your EthStorage account. On the testnet, you can use the [EthStorage Faucet](https://qkc-l2-faucet.eth.sep.w3link.io/). If you need more tokens, please ping us on [Discord](https://discord.com/invite/xhCwaMp7ps), and we can send them over.
    - Run the agent and prompt it with: "send AMOUNT QKC to any other EthStorage account" - e.g. `send 1 QKC to 0x341Cb1a94ef69499F97E93c41707B21326C0Cc87`
    - If the transaction is successful, the agent will return the Tx Hash.
      The tx hash can be checked on the EthStorage block explorer at [https://explorer.beta.testnet.l2.quarkchain.io](https://explorer.beta.testnet.l2.quarkchain.io).

- **Submit Data**
    - To test data submission, you need tokens in your EthStorage account to pay fees. On the testnet, you can use the [EthStorage Faucet](https://qkc-l2-faucet.eth.sep.w3link.io/). If you need more tokens, please ping us on [Discord](https://discord.com/invite/xhCwaMp7ps), and we can send them over.
    - Run the agent and prompt it with: "Submit the following data using the key KEY to EthStorage DATA" - e.g. `Submit the following data using the key 'my_key' to EthStorage "Hello World!"`
    - If the transaction is successful, the agent will return the Tx Hash. The tx hash can be checked on the EthStorage block explorer at [https://explorer.beta.testnet.l2.quarkchain.io](https://explorer.beta.testnet.l2.quarkchain.io).

## Resources
- [EthStorage Documentation](https://docs.ethstorage.io/)
- [Learn more about EthStorage](https://ethstorage.io/)
- [Awesome EthStorage Repo](https://github.com/ethstorage/)

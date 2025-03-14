# @elizaos/plugin-avail - Plugin for Avail

This is a plugin for using Eliza to interact with the Avail DA network. Defaults to Turing testnet, but can be customized to use Mainnet by changing the RPC in the `.env` file at `AVAIL_RPC_URL`.

## Actions
- **transfer**: This action enables the transfer of AVAIL tokens from the agent's wallet (as defined by the keyring generated from `AVAIL_SEED`) to another wallet. To use just mention the transfer of AVAIL tokens to an Avail account.

    - name: `SEND_AVAIL`

    - Message sample: `Send 100 AVAIL to 5GWbvXjefEvXXETtKQH7YBsUaPc379KAQATW1eqeJT26cbsK`

- **submitData**: This action enables the submission of any arbitrary data to the Avail DA network. To use just mention that you need to send "any data" to Avail. You can customize the Avail `appID` through which the agent submits the data by modifying the `AVAIL_APP_ID` env config.

    - name: `SUBMIT_DATA`

    - Message sample: `Submit the following data to Avail "Hello World!"`

## Usage & Testing

### Detailed testing steps
- In `.env` you should set the value for `AVAIL_ADDRESS` (this is the public address for the agent account - [learn how to get one here](https://docs.availproject.org/user-guides/accounts#seed-phrases)) and `AVAIL_SEED` (seed phrase for the same account).

- **Transfer AVAIL**
    - To test transfer function, you need tokens in your Avail account. On testnet, you can use the [Avail Faucet](https://faucet.avail.tools/). If you need more please ping us on [Discord](https://discord.gg/y6fHnxZQX8), and we can send it over. 
    - Run the agent and prompt it with: "send AMOUNT AVAIL to any other Avail account " - e.g. `send 1 AVAIL to 5GWbvXjefEvXXETtKQH7YBsUaPc379KAQATW1eqeJT26cbsK`
    - Assuming everything goes smoothly the agent returns with the Tx Hash, and Block Hash. 
The tx hash can be checked on the Avail block explorer at https://avail-turing.subscan.io/

- **Submit Data**
    - To test data submission, you need tokens in your Avail account to pay fees. On testnet, you can use the [Avail Faucet](https://faucet.avail.tools/). If you need more please ping us on [Discord](https://discord.gg/y6fHnxZQX8), and we can send it over. 
    - Run the agent and prompt it with: "Submit the following data to Avail DATA" - e.g. `Submit the following data to Avail "Hello World!"`
    - Assuming everything goes smoothly the agent returns with the Tx Hash, and Block Hash. The tx hash can be checked on the Avail block explorer at https://avail-turing.subscan.io/


## Resources
- [Avail Documentation](https://docs.availproject.org/)
- [Set up an Avail Account](https://docs.availproject.org/user-guides/accounts#seed-phrases) - Learn how to get your `AVAIL_SEED`
- [Find more Network Information like RPC endpoints](https://docs.availproject.org/docs/networks)
- [Learn more about appIDs](https://docs.availproject.org/docs/build-with-avail/interact-with-avail-da/app-id)
- [Learn more about Avail](https://www.availproject.org/)
- [Awesome Avail Repo](https://github.com/availproject/awesome-avail)


# GOAT Plugin
[GOAT](https://ohmygoat.dev/) 🐐 (Great Onchain Agent Toolkit) is an open-source framework for adding blockchain tools such as wallets, being able to hold or trade tokens, or interacting with blockchain smart contracts, to your AI agent.

This plugin integrates GOAT with Eliza, giving your agent the ability to interact with many different protocols. The current setup adds onchain capabilities to your agent to send and check balances of ETH and USDC. Add all the capabilities you need by adding more plugins (read below for more information)!

## Configure GOAT for your use case
1. Configure the chain you want to use by updating the `wallet.ts` file (see all available chains at [https://ohmygoat.dev/chains](https://ohmygoat.dev/chains))
2. Add the plugins you need to your `getOnChainActions` function (uniswap, polymarket, etc. see all available plugins at [https://ohmygoat.dev/chains-wallets-plugins](https://ohmygoat.dev/chains-wallets-plugins))
3. Build the project running `pnpm build`
4. Add the necessary environment variables to set up your wallet and plugins
5. Run your agent!

## Common Issues
1. **Agent not executing an action**:
    - If you are also using the EVM Plugin, sometimes the agent might confuse the action name with an EVM Plugin action name instead of the GOAT Plugin action. Removing the EVM Plugin should fix this issue. There is no need for you to use both plugins at the same time.
    - If you are using Trump as a character it might be tricky to get them to perform any action since the character is full of prompts that aim to change the topic of the conversation. To fix this try using a different character or create your own with prompts that are more suitable to what the agent is supposed to do.

## Plugins
GOAT itself has several plugins for interacting with different protocols such as Polymarket, Uniswap, and more. (see all available plugins at [https://ohmygoat.dev/chains-wallets-plugins](https://ohmygoat.dev/chains-wallets-plugins))

You can easily add them by installing them and adding them to the `getOnChainActions` function:

```typescript
const tools = getOnChainActions({
  wallet: walletClient,
  plugins: [
    sendETH(),
    erc20({ tokens: [USDC, PEPE] }),
    polymarket(),
    uniswap(),
    // ...
  ],
})
```

## Environment Variables Setup

To set up your environment variables, you will need to provide the following information:

* `EVM_PRIVATE_KEY`: Your EVM wallet private key.
* `EVM_PROVIDER_URL`: Your RPC provider URL (e.g. Infura, Alchemy, etc.).

## Wallets
GOAT supports many different wallets from key pairs to [Crossmint Smart Wallets](https://docs.crossmint.com/wallets/smart-wallets/overview) and Coinbase.

Read more about wallets at [https://ohmygoat.dev/wallets](https://ohmygoat.dev/wallets).

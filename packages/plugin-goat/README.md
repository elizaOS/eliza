# @elizaos/plugin-goat

A plugin for integrating blockchain capabilities through the GOAT (Great Onchain Agent Toolkit) framework within the ElizaOS ecosystem.

## Description

[GOAT](https://ohmygoat.dev/) 🐐 (Great Onchain Agent Toolkit) is an open-source framework for adding blockchain tools such as wallets, being able to hold or trade tokens, or interacting with blockchain smart contracts, to your AI agent.

- [Chains supported](https://ohmygoat.dev/chains-wallets-plugins)
- [Plugins supported](https://ohmygoat.dev/chains-wallets-plugins)

This plugin integrates GOAT with Eliza, giving your agent the ability to interact with many different protocols. The current setup adds onchain capabilities to your agent to send and check balances of ETH and USDC, and to swap tokens using KIM protocol. Add all the capabilities you need by adding more plugins (read below for more information)!

## Installation

```bash
pnpm install @elizaos/plugin-goat
```

## Configuration

### Environment Variables
```typescript
EVM_PRIVATE_KEY=<Your EVM wallet private key>
EVM_PROVIDER_URL=<Your RPC provider URL (e.g., Infura, Alchemy)>
```

## Configure GOAT for your use case

1. Configure the chain you want to use by updating the `wallet.ts` file (see all available chains at [https://ohmygoat.dev/chains](https://ohmygoat.dev/chains))
2. Specify the actions you want to have by updating the `actions.ts` file
3. Add the plugins you need to perform these actions to the `getOnChainTools` function (uniswap, polymarket, etc. see all available plugins at [https://ohmygoat.dev/chains-wallets-plugins](https://ohmygoat.dev/chains-wallets-plugins))
4. Build the project running `pnpm build`
5. Add the necessary environment variables to set up your wallet and plugins
6. Run your agent!

## Common Issues
1. **Agent not executing an action**:
    - If you are also using the EVM Plugin, sometimes the agent might confuse the action name with an EVM Plugin action name instead of the GOAT Plugin action. Removing the EVM Plugin should fix this issue. There is no need for you to use both plugins at the same time.
    - If you are using Trump as a character it might be tricky to get them to perform any action since the character is full of prompts that aim to change the topic of the conversation. To fix this try using a different character or create your own with prompts that are more suitable to what the agent is supposed to do.

## Plugins
GOAT itself has several plugins for interacting with different protocols such as Polymarket, Uniswap, and many more. (see all available plugins at [https://ohmygoat.dev/chains-wallets-plugins](https://ohmygoat.dev/chains-wallets-plugins))

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

See all available plugins at [https://ohmygoat.dev/chains-wallets-plugins](https://ohmygoat.dev/chains-wallets-plugins)

## Common Issues & Troubleshooting

1. **Agent not executing an action**:
   - If you are also using the EVM Plugin, sometimes the agent might confuse the action name with an EVM Plugin action name instead of the GOAT Plugin action. Removing the EVM Plugin should fix this issue. There is no need for you to use both plugins at the same time.
   - If you are using Trump as a character it might be tricky to get them to perform any action since the character is full of prompts that aim to change the topic of the conversation. To fix this try using a different character or create your own with prompts that are more suitable to what the agent is supposed to do.

2. **Wallet Connection Issues**
   - Verify private key is correctly formatted
   - Check RPC endpoint availability
   - Ensure sufficient network balance

3. **Transaction Issues**
   - Verify gas availability
   - Check network congestion
   - Confirm transaction parameters

## Wallets

GOAT supports many different wallets from key pairs to [Crossmint Smart Wallets](https://docs.crossmint.com/wallets/smart-wallets/overview) and Coinbase.

Read more about wallets at [https://ohmygoat.dev/wallets](https://ohmygoat.dev/wallets).

## Security Best Practices

1. **Key Management**
   - Store private keys securely
   - Use environment variables
   - Never expose keys in code

2. **Transaction Safety**
   - Implement transaction limits
   - Validate recipient addresses
   - Double-check transaction amounts

3. **Network Security**
   - Use secure RPC endpoints
   - Implement rate limiting
   - Monitor for suspicious activity

## Development Guide

### Setting Up Development Environment

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

## Future Enhancements

- Additional protocol integrations
- Multi-chain support
- Advanced transaction management
- Enhanced error handling
- Custom protocol adapters
- Smart contract interaction templates

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [GOAT](https://ohmygoat.dev/): Great Onchain Agent Toolkit
- [Crossmint](https://docs.crossmint.com/): Smart wallet infrastructure
- [Uniswap](https://docs.uniswap.org/): Decentralized exchange protocol
- [Polymarket](https://docs.polymarket.com/): Prediction market platform
- [ERC20](https://eips.ethereum.org/EIPS/eip-20): Token standard implementation

Special thanks to:
- The GOAT development team for the onchain agent framework
- The Crossmint team for smart wallet solutions
- The Uniswap and Polymarket teams
- The Ethereum community for ERC standards
- The Eliza community for their contributions and feedback

For more information about GOAT capabilities:
- [GOAT Documentation](https://ohmygoat.dev/)
- [Available Chains](https://ohmygoat.dev/chains)
- [Chains, Wallets & Plugins](https://ohmygoat.dev/chains-wallets-plugins)
- [Smart Wallet Documentation](https://docs.crossmint.com/wallets/smart-wallets/overview)

## License

This plugin is part of the Eliza project. See the main project repository for license information.

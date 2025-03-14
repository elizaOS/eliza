# @elizaos/plugin-zilliqa

A plugin for integrating Zilliqa blockchain capabilities through the GOAT (Great Onchain Agent Toolkit) framework within the ElizaOS ecosystem.

## Description

[GOAT](https://ohmygoat.dev/) 🐐 (Great Onchain Agent Toolkit) is an open-source framework for adding blockchain tools such as wallets, being able to hold or trade tokens, or interacting with blockchain smart contracts, to your AI agent.

- [Chains supported](https://ohmygoat.dev/chains-wallets-plugins)
- [Plugins supported](https://ohmygoat.dev/chains-wallets-plugins)

This plugin integrates the GOAT Zilliqa plugin and wallet with Eliza.

## Installation

```bash
pnpm install @elizaos/plugin-zilliqa
```

## Configuration

### Environment Variables

```typescript
EVM_PRIVATE_KEY=<Your EVM wallet private key>
EVM_PROVIDER_URL=<Your RPC provider URL (e.g., Infura, Alchemy)>
ENABLE_ZILLIQA=1
```

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

## License

This plugin is part of the Eliza project. See the main project repository for license information.

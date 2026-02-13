# @elizaos/plugin-mintclub

Mint Club V2 plugin for [ElizaOS](https://github.com/elizaOS/eliza). Wraps the `mc` CLI (`mint.club-cli`) to provide bonding-curve token operations directly from your ElizaOS agent.

## Features

| Action | Description | CLI Command |
|---|---|---|
| `TOKEN_INFO` | Get token details | `mc info <token>` |
| `TOKEN_PRICE` | Get current token price | `mc price <token>` |
| `SWAP` | Swap tokens via bonding curves | `mc swap -i <input> -o <output> -a <amount>` |
| `WALLET_BALANCE` | Check wallet balances | `mc wallet` |

### Provider

**MINTCLUB_PROVIDER** — injects context about available Mint Club commands into the agent's prompt.

## Setup

1. Install the CLI globally:
   ```bash
   npm install -g mint.club-cli
   ```

2. Set your private key:
   ```
   PRIVATE_KEY=0xYourPrivateKey
   ```

3. Add to your ElizaOS character config:
   ```json
   {
     "plugins": ["@elizaos/plugin-mintclub"]
   }
   ```

## Example Prompts

- "Get info about MINT"
- "What's the price of MINT?"
- "Swap 100 from ETH to MINT"
- "Show my wallet balance"

## License

MIT

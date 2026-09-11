# @agentos/elizaos-plugin

The official ElizaOS plugin for **Agent OS**: the 256-lane parallel execution and settlement layer for Solana.

Legacy single-vault AMMs (like Raydium/Orca) serialize transactions, causing massive `AccountInUse` write-lock contention when multiple AI agents attempt to trade simultaneously. Agent OS solves this by probabilistically routing your agent's micro-swaps across 256 independent PDA lanes, enabling true parallel execution.

## 📦 Installation

```bash
npm install @agentos/elizaos-plugin @solana/web3.js @coral-xyz/anchor
```

## ⚙️ Configuration

Your ElizaOS agent needs a funded Solana wallet to execute transactions. Add the following to your agent's secure enclave or `.env` settings:

```env
SOLANA_PRIVATE_KEY="[64,123,45...]" # JSON array format of your Ed25519 Secret Key
SOLANA_RPC_URL="https://api.devnet.solana.com" # Defaults to Devnet
```

## 🚀 Usage

Register the plugin in your ElizaOS Agent configuration:

```typescript
import { agentOsPlugin } from "@agentos/elizaos-plugin";

const agent = new Agent({
    name: "TradingBot",
    plugins: [agentOsPlugin],
    // ...other config
});
```

### Supported Actions

- **`EXECUTE_MICRO_SWAP`**: Triggers when the agent determines it needs to swap tokens (e.g., "Swap 100 USDC to SOL"). The plugin automatically rolls a random lane (`0-255`), derives the non-overlapping PDA matrices, signs the transaction, and returns the on-chain signature.

## 🔒 Security & Mocks
**This plugin contains ZERO mocks.** 
When an action is triggered, it executes a live CPI (Cross-Program Invocation) to the Solana blockchain. If the agent's wallet lacks sufficient funds, the action will fail natively via the Solana RPC. 

## 🌐 Ecosystem
This plugin is a core component of the **BLACK Hybrid Network**, bridging FDC3 institutional intents into high-frequency Solana liquidity.

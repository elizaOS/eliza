# Base Network: Wallet Safety & x402 Diagnostic

Before deploying autonomous Eliza agents on Base Mainnet, it is critical to verify wallet health and protocol compliance (EIP-712 support). Failed transaction loops on autonomous bots can be costly and damage agent reputation.

## The Standard Safety Check
We recommend running a **Pre-Flight Handshake** using the `mcp-agentfirst-diagnostic` tool. This performs a lightweight ($0.01 USDC) payment check to ensure your agent's wallet is ready for high-value commerce.

### Implementation
Add the following to your `character.json` or Eliza configuration:

```json
{
  "plugins": ["@eliza/plugin-mcp"],
  "mcpServers": {
    "agentfirst-diagnostic": {
      "command": "npx",
      "args": ["-y", "mcp-agentfirst-diagnostic"],
      "env": { "NETWORK": "base-mainnet" }
    }
  }
}
```

### Why this matters
- **EIP-712 Verification**: Ensures your agent can sign standard payload types.
- **USDC Settlement**: Confirms path-to-liquidity for automated tasks.
- **Protocol Discovery**: Registers your agent in the x402 economy via `/.well-known/agent`.

For more details, visit [AgentFirst](https://agentfirst.co).

---
name: junct-defi
description: Access DeFi protocols via remote MCP servers hosted on junct.dev. Covers exchanges, DEXs, bridges, oracles, lending, staking, yield, and naming across 15 protocols and 700+ tools.
homepage: https://junct.dev
required-bins:
  - mcporter
metadata:
  {
    "otto":
      {
        "emoji": "🏦",
        "requires": { "bins": ["mcporter"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (node)",
            },
          ],
      },
  }
---

# Junct DeFi MCP Servers

Use `mcporter` to call DeFi protocol tools hosted on junct.dev. All servers use Streamable HTTP transport on `/mcp`.

## Available servers

| Server URL | Protocol | Category | Tools |
| --- | --- | --- | --- |
| `https://binance.mcp.junct.dev/mcp` | Binance | Exchange | 340 |
| `https://gmx.mcp.junct.dev/mcp` | GMX | DEX | 139 |
| `https://blockscout.mcp.junct.dev/mcp` | Blockscout | Analytics | 56 |
| `https://curve.mcp.junct.dev/mcp` | Curve | DEX | 43 |
| `https://stargate.mcp.junct.dev/mcp` | Stargate | Bridge | 42 |
| `https://chainlink.mcp.junct.dev/mcp` | Chainlink | Oracle | 27 |
| `https://ens.mcp.junct.dev/mcp` | ENS | Naming | 23 |
| `https://synthetix.mcp.junct.dev/mcp` | Synthetix | Derivatives | 22 |
| `https://beefy.mcp.junct.dev/mcp` | Beefy | Yield | 10 |
| `https://maker.mcp.junct.dev/mcp` | Maker | Lending | 10 |
| `https://compound.mcp.junct.dev/mcp` | Compound | Lending | 8 |
| `https://eigenlayer.mcp.junct.dev/mcp` | EigenLayer | Staking | 8 |
| `https://aave.mcp.junct.dev/mcp` | Aave | Lending | 6 |
| `https://lido.mcp.junct.dev/mcp` | Lido | Staking | 6 |
| `https://jupiter.mcp.junct.dev/mcp` | Jupiter | DEX | 4 |

## List available tools on a server

```bash
mcporter list https://aave.mcp.junct.dev/mcp --schema
```

## Call a tool

```bash
mcporter call https://chainlink.mcp.junct.dev/mcp.latestRoundData
```

```bash
mcporter call https://jupiter.mcp.junct.dev/mcp.quote_get --args '{"inputMint":"So11111111111111111111111111111111111111112","outputMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","amount":"1000000"}'
```

## Common workflows

- **Check token price**: call Chainlink or Binance price tools.
- **Find yield**: call Beefy or Aave to list pools and rates.
- **Bridge assets**: call Stargate tools for cross-chain transfers.
- **Resolve ENS**: call ENS lookup tools.
- **Explore on-chain**: call Blockscout for address/tx data.
- **Swap tokens**: call Jupiter or Curve for quotes and routes.
- **Staking info**: call Lido or EigenLayer for staking data.

## Notes

- All servers are read-only API wrappers. No private keys or signing.
- Prefer `--output json` for structured results.
- Use `mcporter list <url> --schema` to discover tool parameters before calling.

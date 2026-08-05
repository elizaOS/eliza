# @elizaos/cheshire-eliza

Cheshire Terminal characters + agent body generator for the Solizardking/eliza fork.

## Character

```ts
import { solizardCheshireCharacter } from "@elizaos/cheshire-eliza";
// or path: packages/cheshire-eliza/src/characters/solizard-cheshire.ts
```

## Body generator

```ts
import { generateAgentBody } from "@elizaos/cheshire-eliza";

const body = generateAgentBody({
  name: "ClawdScout",
  archetype: "trader",
  rails: ["solana", "robinhood"],
});
```

## Plugins (sibling packages)

| Package | Role |
| --- | --- |
| `@elizaos/plugin-robinhood` | RH ERC-8004 forge |
| `@elizaos/plugin-solana-forging` | Metaplex mint forge |
| `@elizaos/plugin-e2b-computer` | E2B sandbox computer |
| `@elizaos/plugin-cheshire-memory` | Hermes + Honcho memory |
| `@elizaos/plugin-clawdbrowser` | **Official** ClawdBrowser `tools.md` catalog (search / describe / list) |
| `@elizaos/plugin-dflow-trade` | **Official** Solana spot trade via DFlow + Helius (DeepSeek-ready) |

### ClawdBrowser tools

Agents get the full SOL GPT tool surface via:

```ts
import clawdBrowserPlugin from "@elizaos/plugin-clawdbrowser";
// CLAWDBROWSER_TOOLS_MD=/Users/8bit/ClawdBrowser/tools.md
```

Actions: `SEARCH_CLAWD_TOOLS`, `DESCRIBE_CLAWD_TOOL`, `LIST_CLAWD_TOOLS`.

### Solana trading (DeepSeek + DFlow + Helius)

```bash
export DEEPSEEK_API_KEY=...
export DFLOW_API_KEY=...
export HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
# optional live:
# export SOLANA_PRIVATE_KEY=...
# export SOLANA_TRADE_LIVE=true
```

Agent utterances: “quote 0.01 SOL to USDC”, “swap 1 USDC to SOL preview”, “trade readiness”.

See [docs/PR_PATH.md](./docs/PR_PATH.md) for PR + remote map.  
See [docs/ELIZA_ALIGNMENT.md](./docs/ELIZA_ALIGNMENT.md) for ActionPlan / bootstrap conventions.

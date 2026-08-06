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

## Clawd Code (CLI companion)

`plugins/clawd-code` now comes from
[https://github.com/Solizardking/clawd-code](https://github.com/Solizardking/clawd-code),
not a vendored local tree.

| Item | Result |
| --- | --- |
| **Source of truth** | Git submodule at `plugins/clawd-code` → `https://github.com/Solizardking/clawd-code.git` |
| **Pinned commit** | `29e3a9dccf6433c1f47710d6dc0470ac0cbec7bc` (`main`) |
| **`.gitmodules`** | `[submodule "plugins/clawd-code"]` with that URL |
| **Package metadata** | `repository` / `homepage` → Solizardking/clawd-code |
| **`install.sh` default** | `CLAWD_CODE_REPO=https://github.com/Solizardking/clawd-code.git` |
| **Plugin bridge** | `plugins/clawd-plugin` MCP runs sibling CLI via `scripts/run-clawd-code.mjs` |

### Verification

- Workspace resolve: `@solana-clawd/clawd-code@workspace:plugins/clawd-code`
- Bridge tests: `bun run --cwd plugins/clawd-plugin test`
- Package tests: `bun run --cwd packages/cheshire-eliza test`
- Install smoke: clone + build of Solizardking/clawd-code produces `dist/cli.js`

### Install (canonical CLI)

```bash
curl -fsSL https://raw.githubusercontent.com/Solizardking/clawd-code/main/install.sh | sh
```

```ts
import {
  CLAWD_CODE_GITHUB,
  CLAWD_MONOREPO_PATHS,
  clawdStackSummary,
} from "@elizaos/cheshire-eliza";
```

## Plugins (sibling packages)

| Package | Role |
| --- | --- |
| `@solana-clawd/clawd-code` | Solana-native AI coding CLI (submodule) |
| `@solana-clawd/clawd-plugin` | Clawd skills + MCP bridge to the CLI |
| `@elizaos/plugin-robinhood` | RH ERC-8004 forge |
| `@elizaos/plugin-solana-forging` | Metaplex mint forge |
| `@elizaos/plugin-e2b-computer` | E2B sandbox computer |
| `@elizaos/plugin-cheshire-memory` | Hermes + Honcho memory |
| `@elizaos/plugin-clawdbrowser` | **Official** ClawdBrowser `tools.md` catalog |
| `@elizaos/plugin-dflow-trade` | **Official** Solana spot via DFlow + Helius |

### Communication map

```text
cheshire-eliza character
  → plugin-cheshire-memory (REMEMBER_TRADE / RECALL_MEMORY)
  → plugin-clawdbrowser (SEARCH/DESCRIBE/LIST tools)
  → plugin-dflow-trade (quote/swap)
  → clawd-plugin (skills + MCP)
       → clawd-code CLI (code / trade / research / arena)
```

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

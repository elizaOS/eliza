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

### ClawdBrowser tools

Agents get the full SOL GPT tool surface via:

```ts
import clawdBrowserPlugin from "@elizaos/plugin-clawdbrowser";
// CLAWDBROWSER_TOOLS_MD=/Users/8bit/ClawdBrowser/tools.md
```

Actions: `SEARCH_CLAWD_TOOLS`, `DESCRIBE_CLAWD_TOOL`, `LIST_CLAWD_TOOLS`.

See [docs/PR_PATH.md](./docs/PR_PATH.md) for PR + remote map.

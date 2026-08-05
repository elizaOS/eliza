# @elizaos/plugin-clawdbrowser

Official elizaOS plugin that gives agents the **ClawdBrowser SOL GPT tool catalog** from [`tools.md`](file:///Users/8bit/ClawdBrowser/tools.md).

Agents can **search**, **describe**, and **list** the 171 non-custodial Solana tools (Phoenix, Imperial, wallets, swaps, browser, Solana Tracker, …) without holding private keys.

## Install (monorepo)

```bash
# workspace already includes plugins/*
bun install

# use on a character
plugins: ["@elizaos/plugin-clawdbrowser"]
```

Or import:

```ts
import clawdBrowserPlugin from "@elizaos/plugin-clawdbrowser";

const character = {
  name: "Clawd",
  plugins: [clawdBrowserPlugin],
};
```

## Env / settings

| Variable | Purpose |
| --- | --- |
| `CLAWDBROWSER_TOOLS_MD` | Path to `tools.md` (highest priority) |
| `CLAWDBROWSER_ROOT` | ClawdBrowser checkout; uses `<root>/tools.md` |
| `CLAWDBROWSER_API_URL` | Optional future live API base |
| `CLAWDBROWSER_ENABLED` | Set `false` to disable |

**Default path tried:** `/Users/8bit/ClawdBrowser/tools.md`, then `~/ClawdBrowser/tools.md`.

## Actions

| Action | Intent |
| --- | --- |
| `SEARCH_CLAWD_TOOLS` | Keyword search over catalog |
| `DESCRIBE_CLAWD_TOOL` | Full description for one tool name |
| `LIST_CLAWD_TOOLS` | List groups or tools in a group |

## Provider

| Provider | Injects |
| --- | --- |
| `CLAWD_BROWSER_TOOLS` | Compact catalog summary (counts, groups, custody rules) |

## Example prompts

- “Search clawd tools for phoenix funding”
- “Describe tool `prepare_user_swap`”
- “List clawd tools in imperial”
- “What tool groups does ClawdBrowser expose?”

## Execution model (from tools.md)

- Research tools return data only.
- Live spends use `prepare_*` → **user wallet signs** → relay only (no server hot wallet).

## Dev

```bash
cd plugins/plugin-clawdbrowser
bun run test
bun run typecheck
bun run build
```

## Cheshire bundle

Included in `@elizaos/cheshire-eliza` plugin list as `@elizaos/plugin-clawdbrowser`.

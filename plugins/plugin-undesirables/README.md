# plugin-undesirables

Personality-as-Code for elizaOS agents — structured "soul workspaces", live TCG market data, and 26 financial/creative skills. Published as `plugin-undesirables` (community plugin, BUSL-1.1).

## What it does

Adds a personality layer and live trading-card market intelligence to any Eliza agent. On the first message, the plugin loads either a built-in demo soul (no config) or an NFT-holder soul from a local workspace directory, then injects that personality into every response. It is opt-in: add it to a character's `plugins` array.

## Install

```json
{
  "plugins": ["plugin-undesirables"]
}
```

With no config, a demo soul loads automatically. To use a downloaded soul workspace, set `UNDESIRABLES_WORKSPACE`:

```json
{
  "plugins": ["plugin-undesirables"],
  "settings": {
    "UNDESIRABLES_WORKSPACE": "/absolute/path/to/soul_workspace"
  }
}
```

## Plugin surface

**Actions (9):** `UNDESIRABLE_MARKET_ANALYSIS`, `UNDESIRABLE_BUSINESS_PILOT`, `UNDESIRABLE_MEME_MACHINE`, `UNDESIRABLE_LOAD_SKILL`, `UNDESIRABLE_WHALE_TRACKER`, `UNDESIRABLE_ENTRY_SIGNAL`, `UNDESIRABLE_PORTFOLIO_CHECK`, `UNDESIRABLE_EXIT_STRATEGY`, `UNDESIRABLE_RISK_ASSESSMENT`. Each validates that a soul workspace is loaded; `BUSINESS_PILOT` and `MEME_MACHINE` additionally require the matching skill.

**Providers (2):**
- `undesirables-oracle` — fetches live TCG product prices and daily market snapshots from `oracle.the-undesirables.com` (no auth). Returns empty unless the message hits TCG/card keywords.
- `undesirables-soul` — injects personality context on every message. Lazy-loads the workspace keyed by `runtime.agentId`, falling back to the built-in `DEMO_SOUL`.

**Evaluators (1):** `UNDESIRABLE_MARKET_INTELLIGENCE` — passive; on TCG card keywords it queries the Oracle search endpoint and calls back with live pricing context.

**Services (1):** `MemeTrendService` (`MEME_TREND_MONITOR`) — cached Imgflip meme-template monitor for Meme Machine context.

**Skills:** the demo soul ships 26 skill descriptions inline. `UNDESIRABLE_LOAD_SKILL` keyword-routes a message to one of 24 of them.

## Soul workspace

A workspace directory may contain:

- `SOUL.md` — YAML frontmatter (`name`, `archetype`, `strategy`, `token_id`, `adjectives`, `risk_tolerance`) plus a personality body.
- `SYSTEM_PROMPT.txt` — optional base system prompt.
- `MEMORY.md` — optional persistent memory entries.
- `PREDICTIONS_LEDGER.json` — optional JSON array of past predictions.
- `skills/` — optional `<skill_name>.md` files merged into the loaded skills.

Example `SOUL.md` frontmatter:

```yaml
---
name: Demo Undesirable
archetype: The Observer
strategy: Cautious Analyst
token_id: demo
adjectives:
  - curious
  - measured
  - direct
risk_tolerance: moderate
---
```

Workspaces are keyed by `runtime.agentId`, so multiple agents can run in one elizaOS instance without personality collision.

## Config

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `UNDESIRABLES_WORKSPACE` | No | (empty — demo soul) | Absolute path to a soul workspace directory containing `SOUL.md`. When absent or invalid, the demo soul loads. |

## Layout

```
src/
  index.ts          Plugin export, all actions, both providers, evaluator,
                    workspace loader, DEMO_SOUL, oracleFetch helper
  environment.ts    validateUndesirableConfig() — checks UNDESIRABLES_WORKSPACE
  services.ts       MemeTrendService (cached Imgflip template monitor)
```

## Commands

```bash
bun run --cwd plugins/plugin-undesirables build   # tsup -> dist/
bun run --cwd plugins/plugin-undesirables clean   # rm -rf dist
bun run --cwd plugins/plugin-undesirables test    # vitest run --passWithNoTests
```

## Security notes

- Path traversal is blocked by `getSafePath()`, which resolves symlinks via `fs.realpathSync` before any workspace read.
- `SOUL.md` frontmatter is parsed with `js-yaml` `JSON_SCHEMA` (no function tags); `__proto__`, `constructor`, and `prototype` keys are stripped.
- User-provided skill content is wrapped in `<untrusted_skill_data>` with a security notice before being added to prompts.
- `oracleFetch()` enforces an 8-second `AbortSignal` timeout and `redirect: "error"`.

## License

[BUSL-1.1](LICENSE) — Business Source License 1.1. Copyright © The Undesirables LLC.

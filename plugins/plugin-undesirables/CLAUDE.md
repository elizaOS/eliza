# plugin-undesirables

Personality-as-Code for elizaOS agents — structured soul workspaces, live TCG market data, and 24 financial/creative skills.

## Purpose / role

Adds a personality layer ("soul workspace") and live trading-card market intelligence to any Eliza agent. On init, the plugin loads either a demo soul (no config required) or an NFT-holder-specific soul from a local workspace directory, then injects that personality into every response via a provider. It is an opt-in plugin added to a character's `plugins` array — not default-enabled in the elizaOS runtime.

## Plugin surface

### Actions (9)

| Name | Trigger |
|---|---|
| `UNDESIRABLE_MARKET_ANALYSIS` | Personality-driven market/token analysis with conviction score |
| `UNDESIRABLE_BUSINESS_PILOT` | AI business automation recommendations (phone answering, SMS, invoicing) |
| `UNDESIRABLE_MEME_MACHINE` | Meme concepts, brand voice content, content calendars |
| `UNDESIRABLE_LOAD_SKILL` | Keyword-routes the user's message to one of 24 soul skills |
| `UNDESIRABLE_WHALE_TRACKER` | Whale wallet movement and smart money flow analysis |
| `UNDESIRABLE_ENTRY_SIGNAL` | GO / WAIT / NO-GO entry evaluation with support/resistance levels |
| `UNDESIRABLE_PORTFOLIO_CHECK` | Portfolio health assessment, A–F rating, concentration risk |
| `UNDESIRABLE_EXIT_STRATEGY` | TP1/TP2/TP3 take-profit levels, stop losses, time-based exit rules |
| `UNDESIRABLE_RISK_ASSESSMENT` | Risk rating 1–10 with SAFE / CAUTION / DANGER verdict |

All actions validate that a workspace is loaded (`getWorkspace(runtime) !== null`). Actions requiring a specific skill (`business_pilot`, `meme_machine`) also check the skill exists in the workspace.

### Providers (2)

| Name | Role |
|---|---|
| `undesirables-oracle` | Fetches live TCG product prices and daily market snapshots from `oracle.the-undesirables.com`. Triggers on TCG/card keywords; returns empty string otherwise. No auth required. |
| `undesirables-soul` | Injects personality context on every message. Lazy-loads the workspace keyed by `runtime.agentId` on first call. Falls back to the built-in `DEMO_SOUL` when no workspace is configured. |

### Evaluators (1)

| Name | Role |
|---|---|
| `UNDESIRABLE_MARKET_INTELLIGENCE` | Passive evaluator; triggers on TCG card keywords (e.g., "charizard", "psa grade"). Fetches Oracle search results and calls back with live pricing context without requiring an explicit user action. |

### Services (1)

| Name | Type | Role |
|---|---|---|
| `MemeTrendService` | `MEME_TREND_MONITOR` | Scaffold — currently a no-op registered to reserve the service type. Planned: poll trending meme templates and inject into Meme Machine context. |

## Layout

```
src/
  index.ts          Plugin export, all actions, both providers, evaluator,
                    workspace loader, multi-agent workspace Map,
                    built-in DEMO_SOUL constant, oracleFetch helper
  environment.ts    validateUndesirableConfig() — checks UNDESIRABLES_WORKSPACE
                    exists and contains SOUL.md
  services.ts       MemeTrendService (no-op scaffold)
```

## Commands

```bash
bun run --cwd plugins/plugin-undesirables build   # tsup -> dist/
bun run --cwd plugins/plugin-undesirables clean   # rm -rf dist
bun run --cwd plugins/plugin-undesirables test    # vitest run --passWithNoTests
```

## Config / env vars

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `UNDESIRABLES_WORKSPACE` | No | (empty — demo soul) | Absolute path to a soul workspace directory containing `SOUL.md`. Set in character.json `settings` or as an env var. When absent or invalid, the demo soul loads automatically. |

The workspace directory is expected to contain:
- `SOUL.md` — YAML frontmatter (name, archetype, strategy, adjectives, risk_tolerance) + personality body
- `SYSTEM_PROMPT.txt` — optional base system prompt
- `MEMORY.md` — optional persistent memory entries
- `PREDICTIONS_LEDGER.json` — optional JSON array of past predictions
- `skills/` — optional directory of `<skill_name>.md` files (override the built-in 24 skills)

## How to extend

**Add a new action:**
1. Define an `Action` object in `src/index.ts` following the pattern of existing actions.
2. Call `buildSkillContext()` + `generateResponse()` inside the handler.
3. Append the action to the `actions` array in `undesirablePlugin`.
4. Add trigger words to the `skillMatches` map in `UNDESIRABLE_LOAD_SKILL` if the action has a corresponding skill.

**Add a new provider:**
1. Define a `Provider` object with a `get` method returning `ProviderResult`.
2. Add it to the `providers` array in `undesirablePlugin`.

**Add a new service:**
1. Extend `Service` from `@elizaos/core` in `src/services.ts`.
2. Add it to the `services` array in `undesirablePlugin`.

## Conventions / gotchas

- **Multi-agent safety:** workspaces are stored in a module-level `Map<agentId, SoulWorkspace>`. Never use a global singleton for workspace state — always key by `runtime.agentId`.
- **Path traversal protection:** `getSafePath()` resolves symlinks via `fs.realpathSync` before returning any workspace file path. Do not bypass it for new file reads from the workspace.
- **YAML parsing:** frontmatter is parsed with `js-yaml` `JSON_SCHEMA` mode (no function tags). `__proto__`, `constructor`, `prototype` keys are explicitly stripped.
- **Skill content prompt injection:** user-provided skill `.md` files are wrapped in `<untrusted_skill_data>` with a security notice. Do not remove this wrapper when adding skill context to prompts.
- **Oracle fetch:** `oracleFetch()` enforces an 8-second `AbortSignal` timeout and `redirect: "error"`. Always use this helper for Oracle API calls.
- **Demo soul:** the `DEMO_SOUL` constant in `index.ts` is the fallback personality. It ships with all 24 skill descriptions inline (no files). This is the path taken when `UNDESIRABLES_WORKSPACE` is unset or invalid.
- **No npm scope:** this package is published as `plugin-undesirables` (not `@elizaos/plugin-undesirables`). It is a community plugin, not a first-party elizaOS package.
- **License:** BUSL-1.1 — not MIT/Apache. Review before redistributing.
- **`MemeTrendService`** is a declared stub. Its `pollTrends()` method is never called. Do not treat it as functional until it is wired to a real polling loop.
- The root `AGENTS.md` covers repo-wide logger, ESM, and architecture rules — they apply here too.

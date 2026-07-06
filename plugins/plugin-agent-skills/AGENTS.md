# @elizaos/plugin-agent-skills

Implements the [Agent Skills specification](https://agentskills.io) — modular, file-based capabilities an Eliza agent discovers, manages, and invokes with progressive context disclosure.

## Purpose / role

This plugin gives an Eliza agent a full skill lifecycle: discover skills from the ClawHub registry, install/uninstall them, surface their metadata in the agent prompt at low token cost, and inject full instructions only when a skill is contextually matched. Auto-enable gate: the plugin activates when `config.features.agentSkills` is truthy (checked by `auto-enable.ts` and the `shouldEnable` function inside `plugin.ts`).

## Plugin surface

### Actions
| Name | File | Description |
|------|------|-------------|
| `USE_SKILL` | `src/actions/use-skill.ts` | Canonical entry point — invokes an enabled skill by slug. Accepts `mode` (`auto`/`guidance`/`script`). Similes: `INVOKE_SKILL`, `RUN_SKILL`, `EXECUTE_SKILL`, `CALL_SKILL`, `USE_AGENT_SKILL`, `RUN_AGENT_SKILL`, `USE_CAPABILITY`, `RUN_CAPABILITY`. |
| `SKILL` (`skillAction`) | `src/actions/skill.ts` | Catalog-management parent action. Exposes one `action` parameter with enum `search`/`details`/`sync`/`toggle`/`install`/`uninstall`, and routes each op to the matching subaction module below (by the `action` param or by message-text pattern). |

`plugin.ts` registers the parent via `...promoteSubactionsToActions(skillAction)`, which synthesizes virtual top-level actions `SKILL_SEARCH`, `SKILL_DETAILS`, `SKILL_SYNC`, `SKILL_TOGGLE`, `SKILL_INSTALL`, `SKILL_UNINSTALL` from that enum (each just pins the discriminator and delegates to `skillAction.handler`). The op-handler modules are NOT separate top-level actions — each exports an `*Action` whose `name` is `"SKILL"` and is consumed only through the parent's `ROUTES`:

| Op | Export | File |
|----|--------|------|
| `search` | `searchSkillsAction` | `src/actions/search-skills.ts` |
| `details` | `getSkillDetailsAction` | `src/actions/get-skill-details.ts` |
| `sync` | `syncCatalogAction` | `src/actions/sync-catalog.ts` |
| `toggle` | `toggleSkillAction` | `src/actions/toggle-skill.ts` |
| `install` | `installSkillAction` | `src/actions/install-skill.ts` |
| `uninstall` | `uninstallSkillAction` | `src/actions/uninstall-skill.ts` |

### Providers
| Name | File | Description |
|------|------|-------------|
| `enabled_skills` | `src/providers/enabled-skills.ts` | Canonical slug→description map for USE_SKILL planning. Position `-10`, scoped to `agent_internal`/`settings`. |
| `agent_skills` | `src/providers/skills.ts` (`skillsSummaryProvider`) | Medium-res list of installed skills with descriptions. |
| `agent_skill_instructions` | `src/providers/skills.ts` (`skillInstructionsProvider`) | High-res: full SKILL.md body for contextually matched skills. |
| `agent_skills_catalog` | `src/providers/skills.ts` (`catalogAwarenessProvider`) | Dynamic: catalog category awareness when user asks about capabilities. |

### Services
| Name | File | Description |
|------|------|-------------|
| `AGENT_SKILLS_SERVICE` | `src/services/skills.ts` (`AgentSkillsService`) | Core service: discovers/loads/validates skills, manages registry calls, exposes `getLoadedSkills()`, `install()`, `syncCatalog()`, etc. |

### Background tasks
| Name | File | Description |
|------|------|-------------|
| `agent-skills-sync` | `src/tasks/sync-catalog.ts` (`syncCatalogTask`) | Periodic hourly catalog sync started in `plugin.init` via `startSyncTask`. |

### API route handlers (consumed by agent's HTTP server)
| Export | File | Description |
|--------|------|-------------|
| `handleSkillsRoutes` | `src/api/skills-routes.ts` | REST handlers: skill CRUD, catalog install/uninstall, marketplace, acknowledgements, workspace discovery. |
| `handleCuratedSkillsRoutes` | `src/api/curated-skills-routes.ts` | Routes for curated/bundled skill sets. |
| `discoverSkills`, `loadSkillPreferences`, `saveSkillPreferences` | `src/api/skill-discovery-helpers.ts` | Workspace skill discovery helpers used by the API layer. |
| `skillScaffoldMarkdown` | `src/api/skill-scaffold.ts` | Generates a starter SKILL.md template string. |

## Layout

```
plugins/plugin-agent-skills/
├── auto-enable.ts          # Lightweight auto-enable gate (no transitive imports)
├── src/
│   ├── index.ts            # Barrel — all public exports + bundle-safety shims
│   ├── plugin.ts           # Plugin object: wires actions/providers/services, init/dispose
│   ├── types.ts            # All domain types (SkillFrontmatter, OttoMetadata, etc.)
│   ├── parser.ts           # parseFrontmatter, validateFrontmatter, generateSkillsJson, estimateTokens
│   ├── storage.ts          # ISkillStorage, MemorySkillStore, FileSystemSkillStore, createStorage
│   ├── agent-runtime-shim.ts  # inert integration-telemetry span factory + resolveDefaultAgentWorkspaceDir helper
│   ├── actions/
│   │   ├── use-skill.ts    # USE_SKILL action (canonical invocation)
│   │   ├── skill.ts        # SKILL parent action (routes to sub-actions below)
│   │   ├── search-skills.ts
│   │   ├── get-skill-details.ts
│   │   ├── install-skill.ts
│   │   ├── uninstall-skill.ts
│   │   ├── toggle-skill.ts
│   │   ├── sync-catalog.ts
│   │   ├── parse-helpers.ts  # Shared param parsing for actions
│   │   └── validators.ts     # Slug/input validation
│   ├── providers/
│   │   ├── enabled-skills.ts # enabled_skills provider (position -10)
│   │   └── skills.ts         # summary, instructions, catalog providers
│   ├── services/
│   │   ├── skills.ts           # AgentSkillsService (AGENT_SKILLS_SERVICE)
│   │   ├── install.ts          # Dependency install helpers (brew/apt/pip/cargo/npm)
│   │   ├── skill-catalog-client.ts  # Cached catalog client (skills/.cache/catalog.json)
│   │   └── skill-marketplace.ts     # Marketplace install/uninstall/search
│   ├── api/
│   │   ├── skills-routes.ts         # HTTP handlers for skill management endpoints
│   │   ├── curated-skills-routes.ts # HTTP handlers for curated skill sets
│   │   ├── skill-discovery-helpers.ts
│   │   └── skill-scaffold.ts        # SKILL.md template generator
│   ├── tasks/
│   │   └── sync-catalog.ts   # syncCatalogTask + startSyncTask (hourly interval)
│   ├── security/
│   │   ├── index.ts
│   │   ├── skill-scanner.ts
│   │   ├── manifest-scanner.ts
│   │   ├── markdown-scanner.ts
│   │   └── types.ts
│   └── __tests__/
│       └── core-test-mock.ts
```

## Commands

All scripts use `bun run --cwd plugins/plugin-agent-skills <script>`:

```bash
bun run --cwd plugins/plugin-agent-skills build        # tsup + tsc declaration emit
bun run --cwd plugins/plugin-agent-skills dev          # tsup --watch
bun run --cwd plugins/plugin-agent-skills clean        # rm -rf dist
bun run --cwd plugins/plugin-agent-skills typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-agent-skills test         # vitest run
bun run --cwd plugins/plugin-agent-skills lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-agent-skills lint:check   # biome lint (read-only)
bun run --cwd plugins/plugin-agent-skills format       # biome format --write
bun run --cwd plugins/plugin-agent-skills format:check # biome format (read-only)
```

## Config / env vars

All variables are optional. Read by `AgentSkillsService` at `initialize()` time from `runtime.getSetting(key)`:

| Var | Default | Description |
|-----|---------|-------------|
| `SKILLS_DIR` | `./skills` | Directory to load and install skills from. Alias: `CLAWHUB_SKILLS_DIR`. |
| `SKILLS_AUTO_LOAD` | `true` | Load installed skills on startup. Alias: `CLAWHUB_AUTO_LOAD`. |
| `SKILLS_REGISTRY` | `https://clawhub.ai` | Skill registry base URL. Alias: `CLAWHUB_REGISTRY`. |
| `SKILLS_STORAGE_TYPE` | — | Storage backend override (`memory` or `filesystem`). Auto-detected if unset. |
| `SKILLS_SYNC_CATALOG_ON_START` | `true` | Sync the remote catalog on plugin startup. Set to `false` to skip. |
| `SKILLS_AUTO_REFRESH` | `false` | Automatically refresh skills from disk on access. |
| `SKILLS_ALLOWLIST` | — | Comma-separated slugs to allow (all others blocked). Alias: `skills.allowlist`. |
| `SKILLS_DENYLIST` | — | Comma-separated slugs to block. Alias: `skills.denylist`. |
| `BUNDLED_SKILLS_DIRS` | — | Comma-separated paths containing read-only bundled skill dirs. |
| `OTTO_BUNDLED_SKILLS_DIR` | — | Legacy: single Otto bundled skills directory. |
| `WORKSPACE_SKILLS_DIR` | — | Directory for workspace-scoped skills. Alias: `OTTO_WORKSPACE_SKILLS_DIR`. |
| `PLUGIN_SKILLS_DIRS` | — | Comma-separated directories for plugin-contributed skills. Alias: `OTTO_PLUGIN_SKILLS_DIRS`. |
| `EXTRA_SKILLS_DIRS` | — | Additional skill directories. Aliases: `OTTO_EXTRA_SKILLS_DIRS`, `skills.load.extraDirs`. |

Auto-enable gate (not a runtime env var): `config.features.agentSkills` must be truthy in the agent character config.

## How to extend

**Add a new action:**
1. Create `src/actions/<name>.ts` implementing `Action` from `@elizaos/core`.
2. Import and add it to `ALL_ACTIONS` in `src/plugin.ts`.
3. Re-export from `src/index.ts`.

**Add a new provider:**
1. Create or extend a file in `src/providers/`.
2. Import and add it to `ALL_PROVIDERS` in `src/plugin.ts`.
3. Re-export from `src/index.ts`.

**Add a new service:**
1. Extend `AgentSkillsService` in `src/services/skills.ts` or create a new class extending `Service` from `@elizaos/core`.
2. Add to `ALL_SERVICES` in `src/plugin.ts`.

**Authoring a SKILL.md:** See the Agent Skills spec at https://agentskills.io/specification and the scaffold template at `src/api/skill-scaffold.md` (template string also exported as `skillScaffoldMarkdown` from `src/api/skill-scaffold.ts`).

## Conventions / gotchas

- **Progressive disclosure levels:** The service exposes skills at three levels — metadata only (100 tokens), full instructions (<5 k tokens), and on-demand resources. Providers are wired to these levels; do not load full instructions in the summary provider.
- **Source precedence:** `workspace > managed > bundled > plugin > extra`. `AgentSkillsService` respects this order when loading conflicting slugs. Defined in `SKILL_SOURCE_PRECEDENCE` in `src/types.ts`.
- **Storage modes:** `MemorySkillStore` (browser/sandbox/test) and `FileSystemSkillStore` (Node.js). `createStorage` auto-detects. Use memory mode in tests.
- **Bundle-safety shims:** `src/index.ts` contains explicit re-import bindings at the bottom to prevent Bun's tree-shaker from collapsing the barrel into an empty `init` function on mobile targets. Do not remove them.
- **`auto-enable.ts` must stay lightweight:** No transitive imports of the full plugin runtime. The auto-enable engine loads this file for every plugin at boot.
- **USE_SKILL vs SKILL:** `USE_SKILL` is the stable invocation surface for callers. `SKILL` (and its promoted `SKILL_<OP>` variants) covers lifecycle management. Keep them separate.
- **Catalog cache:** Lives at `skills/.cache/catalog.json` on disk. `AgentSkillsService` has in-memory TTL caches (catalog 1 h, details 30 min, search 5 min) with a 5-min error cooldown to avoid hammering the registry.
- **Script timeout:** `USE_SKILL` script execution times out at 60 seconds (`SCRIPT_TIMEOUT_MS`).
- **Node.js only:** `package.json` `eliza.platforms` lists `node`. Do not add browser-incompatible code outside of guarded filesystem paths.

See root `AGENTS.md` for repo-wide architecture rules, logger conventions, and git workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->

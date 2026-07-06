# @elizaos/plugin-commands

Chat command system for Eliza agents — registers a slash-command surface (`/help`, `/status`, `/reset`, etc.) and a provider that injects command context into the LLM prompt only when needed.

## Purpose / role

Adds a structured slash-command system to any Eliza agent. Commands are detected by text prefix (`/` or `!`), registered as a `COMMAND_REGISTRY` provider, and handled by deterministic `*_COMMAND` actions this plugin registers directly (the `commandActions` array). The plugin also owns the wire-serialization (`serializeCommand`), connector catalog, and dispatch layer that every surface consumes. Auto-enabled when `config.features.commands` is truthy; controlled by `auto-enable.ts`.

## Plugin surface

**Actions**

| Name | Description |
|---|---|
| `*_COMMAND` (one per deterministic key, e.g. `HELP_COMMAND`, `THINK_COMMAND`, `RESET_COMMAND`) | Deterministic handlers for the built-in agent-target commands owned by this plugin, built from `DETERMINISTIC_COMMAND_KEYS` via `createCommandActions()`. Each `validate()` is strictly slash-only (never intercepts conversational text) and re-scopes to the per-runtime store. The pre-LLM shortcut gate dispatches these before inference; they are also registered so the planner can route to them as a fallback. |

**Providers**

| Name | Description |
|---|---|
| `COMMAND_REGISTRY` | Injects full command list into the LLM context only when the incoming message is a slash command; returns a minimal/empty hint otherwise. Scoped per `agentId`. |

**Exported plugin object**: `commandsPlugin` (default export, also named export)

No services, evaluators, routes, or events are registered by this plugin. Beyond the actions + provider it exports the catalog layer (`serializeCommand`, `getCatalogCommands`, `getConnectorCommands`, `navigationCommandDefinitions`) and the dispatch helpers that consuming surfaces use.

## Layout

```
src/
  index.ts              Plugin entry — exports commandsPlugin (with actions: commandActions),
                        commandRegistryProvider, formatCommandResult, isAuthorized, isElevated,
                        and re-exports actions/parser/registry/types/serialize/connector-catalog/
                        connector-bridge/navigation-commands/settings-sections
  registry.ts           Per-runtime command store: DEFAULT_COMMANDS (built-in defs),
                        initForRuntime(), useRuntime(), registerCommand(), registerCommands(),
                        unregisterCommand(), resetCommands(), getCommands(),
                        getEnabledCommands(), getCommandsByCategory(),
                        findCommandByAlias(), findCommandByKey(), startsWithCommand()
  parser.ts             Text parsing: hasCommand(), detectCommand(), parseCommand(),
                        normalizeCommandBody(), extractCommand(), isCommandOnly()
  types.ts              Shared types: CommandDefinition, CommandTarget, CommandSurface,
                        CommandArgSource, SerializedCommand, SerializedCommandArg,
                        CommandContext, CommandResult, ParsedCommand, CommandScope,
                        CommandCategory, CommandArgDefinition, ClientCommandAction
  serialize.ts          serializeCommand() — the canonical CommandDefinition → SerializedCommand
                        projection (the GET /api/commands wire shape); commandVisibleForSurface()
  navigation-commands.ts  navigationCommandDefinitions() — navigate + client commands as
                        first-class CommandDefinitions (target navigate/client, surfaces, icons)
  connector-catalog.ts  Connector-neutral catalog: getConnectorCommands(surface) (→ ConnectorCommand)
                        and getCatalogCommands(surface) (→ SerializedCommand[]); unions the agent
                        registry with navigation/client commands, filters by surface + active view.
  actions/              Deterministic command action layer: command-actions.ts (createCommandActions,
                        commandActions), handlers.ts (DETERMINISTIC_COMMAND_KEYS + handlers),
                        dispatch.ts (dispatch helper for the pre-LLM gate / connectors),
                        command-settings.ts (per-conversation settings store)
  settings-sections.ts  Settings section registry: SETTINGS_SECTIONS, resolveSettingsSection(),
                        getSettingsSectionChoices() — canonical /settings <section> tokens.

auto-enable.ts  Lightweight shouldEnable() — reads config.features.commands;
                loaded by the auto-enable engine at boot (no full plugin import)
```

## Commands

```bash
bun run --cwd plugins/plugin-commands build         # bun build + tsc declarations
bun run --cwd plugins/plugin-commands dev           # hot-rebuild with bun --hot
bun run --cwd plugins/plugin-commands test          # vitest run
bun run --cwd plugins/plugin-commands typecheck     # tsgo --noEmit
bun run --cwd plugins/plugin-commands lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-commands format        # biome format --write
bun run --cwd plugins/plugin-commands clean         # rm dist/.turbo artifacts
```

## Config / env vars

All vars are read during `plugin.init(config, runtime)`. None are required.

| Var | Default | Description |
|---|---|---|
| `COMMANDS_CONFIG_ENABLED` | `"false"` | Enable `/config` command |
| `COMMANDS_DEBUG_ENABLED` | `"false"` | Enable `/debug` command |
| `COMMANDS_BASH_ENABLED` | `"false"` | Enable `/bash` shell execution (elevated) |
| `COMMANDS_RESTART_ENABLED` | `"true"` | Enable `/restart` command |

Auto-enable gate: `config.features.commands` — truthy object or `true` enables the plugin.

## Built-in command definitions

Defined in `src/registry.ts` as `DEFAULT_COMMANDS`. Each agent runtime receives an isolated copy via `initForRuntime(agentId)`.

**Status** (`category: "status"`): `help` (`/help /h /?`), `commands` (`/commands /cmds`), `status` (`/status /s`), `context` (`/context /ctx`), `whoami` (`/whoami /who`)

**Session** (`category: "session"`): `stop` (`/stop /abort /cancel`), `restart` (`/restart`, auth), `reset` (`/reset`, auth), `new` (`/new`), `compact` (`/compact`)

**Options** (`category: "options"`): `think` (`/think /thinking /t`), `verbose` (`/verbose /v`), `reasoning` (`/reasoning /reason`), `elevated` (`/elevated /elev`, auth), `model` (`/model /m`), `models` (`/models`), `usage` (`/usage`), `queue` (`/queue /q`)

**Management** (`category: "management"`): `allowlist` (`/allowlist /allow`, auth), `approve` (`/approve`, auth), `subagents` (`/subagents /sub`, auth), `config` (`/config /cfg`, auth, disabled by default), `debug` (`/debug`, auth, disabled by default)

**Media** (`category: "media"`): `tts` (`/tts /voice`)

**Tools** (`category: "tools"`): `bash` (`/bash /sh /!`, auth + elevated, disabled by default)

## How to extend

**Add a command definition** (registers it in the registry; built-in deterministic keys get a `*_COMMAND` action automatically — see `actions/`; a custom command still needs a handler):

```ts
import { registerCommand } from "@elizaos/plugin-commands";

registerCommand({
  key: "mycommand",
  description: "Does something useful",
  textAliases: ["/mycommand", "/mc"],
  scope: "both",
  category: "tools",
  acceptsArgs: true,
  args: [{ name: "target", description: "What to act on" }],
});
```

**Add an action** that handles a registered command: create an `Action` in your plugin with a `validate()` that calls `hasCommand(message.content.text)` and `detectCommand()` to match the right key, then implement `handler()`. See `src/index.ts` comments on validate/simile design.

**Add a provider**: follow the `COMMAND_REGISTRY` provider pattern in `src/index.ts`. Call `useRuntime(runtime.agentId)` before accessing registry functions so you operate on the correct per-agent store.

## Conventions / gotchas

- **Registry is per-agent.** `initForRuntime(agentId)` must be called in `plugin.init()` before any registry access; otherwise all agents share the fallback store. The plugin's own `init()` already does this.
- **Built-in deterministic actions live here.** The plugin registers `*_COMMAND` actions for deterministic built-in keys (`commandActions`, built from `DETERMINISTIC_COMMAND_KEYS` via `createCommandActions()` in `actions/`): status/help-style commands, option-setting commands owned by the command-settings store, and the reset/new/compact session commands. Broader management commands whose side effects live outside this package (`stop`, `restart`, `allowlist`, `approve`, etc.) still flow through the normal pipeline. Plugin-specific or skill commands still register their own Action objects elsewhere.
- **Similes must be slash-only.** Never add natural-language similes to command actions — the LLM will misroute conversational messages.
- **`bash` command is elevated + disabled by default.** `requiresElevated: true` in the definition; `enabled` is set to `false` during `init()` because `COMMANDS_BASH_ENABLED` defaults to `"false"`. Set `COMMANDS_BASH_ENABLED=true` to enable it.
- **Provider context-gates itself.** For non-command messages the provider returns an empty string to keep the prompt clean.
- **Parser accepts `/` or `!` prefix.** The `!` prefix is treated the same as `/`.
- **`auto-enable.ts` is a separate entry point** — it must stay lightweight (no plugin runtime imports) because it is loaded by the auto-enable engine for every plugin at boot.
- **`connector-catalog.ts` for remote connectors.** Use `getConnectorCommands(surface)` to get a connector-neutral view of all commands; `kind: "client"` targets are already filtered off remote connectors (Discord, Telegram, etc.).

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

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->

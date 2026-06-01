# @elizaos/plugin-commands

Chat command system for Eliza agents — registers a slash-command surface (`/help`, `/status`, `/reset`, etc.) and a provider that injects command context into the LLM prompt only when needed.

## Purpose / role

Adds a structured slash-command system to any Eliza agent. Commands are detected by text prefix (`/` or `!`) and registered as a `COMMAND_REGISTRY` provider; the actual handlers are expected to be implemented by the consuming agent or other plugins (this plugin supplies the registry, parser, and types — not action handlers). Auto-enabled when `config.features.commands` is truthy; controlled by `auto-enable.ts`.

## Plugin surface

**Providers**

| Name | Description |
|---|---|
| `COMMAND_REGISTRY` | Injects full command list into the LLM context only when the incoming message is a slash command; returns a minimal/empty hint otherwise. Scoped per `agentId`. |

**Exported plugin object**: `commandsPlugin` (default export, also named export)

No actions, services, evaluators, routes, or events are registered directly by this plugin. It provides the registry and parser infrastructure; other plugins register handlers against it.

## Layout

```
src/
  index.ts      Plugin entry — exports commandsPlugin, commandRegistryProvider,
                formatCommandResult, isAuthorized, isElevated, and re-exports
                parser/registry/types
  registry.ts   Per-runtime command store: DEFAULT_COMMANDS (25 built-in defs),
                initForRuntime(), useRuntime(), registerCommand(), registerCommands(),
                unregisterCommand(), resetCommands(), getCommands(),
                getEnabledCommands(), getCommandsByCategory(),
                findCommandByAlias(), findCommandByKey(), startsWithCommand()
  parser.ts     Text parsing: hasCommand(), detectCommand(), parseCommand(),
                normalizeCommandBody(), extractCommand(), isCommandOnly()
  types.ts      Shared types: CommandDefinition, CommandContext, CommandResult,
                ParsedCommand, CommandDetectionResult, ResolvedCommand,
                CommandScope, CommandCategory, CommandArgDefinition

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

**Add a command definition** (registers it in the registry; you still need an action handler elsewhere):

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
- **No action handlers here.** This plugin registers command *definitions* and the provider. The actual Action objects that handle commands live in the agent or other plugins.
- **Similes must be slash-only.** Never add natural-language similes to command actions — the LLM will misroute conversational messages.
- **`bash` command is elevated + disabled by default.** `requiresElevated: true` in the definition; `enabled` is set to `false` during `init()` because `COMMANDS_BASH_ENABLED` defaults to `"false"`. Set `COMMANDS_BASH_ENABLED=true` to enable it.
- **Provider context-gates itself.** For non-command messages the provider returns an empty string to keep the prompt clean.
- **Parser accepts `/` or `!` prefix.** The `!` prefix is treated the same as `/`.
- **`auto-enable.ts` is a separate entry point** — it must stay lightweight (no plugin runtime imports) because it is loaded by the auto-enable engine for every plugin at boot.

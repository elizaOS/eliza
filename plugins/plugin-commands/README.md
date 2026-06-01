# @elizaos/plugin-commands

Chat command system for [elizaOS](https://github.com/elizaos/eliza) agents. Adds a `/help`-style slash-command surface with a shared registry, parser, and LLM context provider.

## What it does

- Provides a typed command registry that other plugins and the agent runtime use to register slash commands.
- Detects `/` and `!`-prefixed messages and parses them into structured `ParsedCommand` objects.
- Injects a `COMMAND_REGISTRY` provider into the LLM context — full command documentation only when the message is a command, an empty hint otherwise (keeps normal-message prompts clean).
- Ships 25 built-in command *definitions* grouped by category. The actual Action handlers live in the agent or other plugins.

## Built-in commands

| Category | Commands |
|---|---|
| Status | `/help` (`/h`, `/?`), `/commands` (`/cmds`), `/status` (`/s`), `/context` (`/ctx`), `/whoami` (`/who`) |
| Session | `/stop` (`/abort`, `/cancel`), `/restart`\*, `/reset`\*, `/new`, `/compact` |
| Options | `/think` (`/thinking`, `/t`), `/verbose` (`/v`), `/reasoning` (`/reason`), `/elevated`\* (`/elev`), `/model` (`/m`), `/models`, `/usage`, `/queue` (`/q`) |
| Management | `/allowlist`\* (`/allow`), `/approve`\*, `/subagents`\* (`/sub`), `/config`\*† (`/cfg`), `/debug`\*† |
| Media | `/tts` (`/voice`) |
| Tools | `/bash`\*‡ (`/sh`, `/!`) |

\* Requires auth (`requiresAuth: true`).
† Disabled by default.
‡ Requires elevated permissions AND is disabled by default.

## Installation

```bash
bun add @elizaos/plugin-commands
```

The plugin is **opt-in**. It auto-enables when `config.features.commands` is truthy in your agent configuration.

## Configuration

Add to your agent's character/config file:

```json
{
  "features": {
    "commands": true
  }
}
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `COMMANDS_CONFIG_ENABLED` | `false` | Enable `/config` command |
| `COMMANDS_DEBUG_ENABLED` | `false` | Enable `/debug` command |
| `COMMANDS_BASH_ENABLED` | `false` | Enable `/bash` shell execution (elevated) |
| `COMMANDS_RESTART_ENABLED` | `true` | Enable `/restart` command |

## Registering a custom command

```ts
import { registerCommand } from "@elizaos/plugin-commands";

registerCommand({
  key: "ping",
  description: "Ping the agent",
  textAliases: ["/ping"],
  scope: "both",
  category: "status",
  acceptsArgs: false,
});
```

You still need an `Action` in your plugin to handle the command. Use `hasCommand()` and `detectCommand()` from `@elizaos/plugin-commands` in your action's `validate()` to match the right key.

## Parser API

```ts
import { hasCommand, detectCommand, normalizeCommandBody } from "@elizaos/plugin-commands";

hasCommand("/help");                   // true
hasCommand("hello world");            // false
detectCommand("/think:high");          // { isCommand: true, command: { key: "think", args: ["high"], ... } }
normalizeCommandBody("@bot /status", "bot"); // "/status"
```


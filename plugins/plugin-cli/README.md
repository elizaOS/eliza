# @elizaos/plugin-cli

CLI framework plugin for elizaOS agents. Provides a Commander-based command registry, TTY-aware progress reporting, and common helpers (duration parsing, byte formatting) for building agent-driven CLI tools.

## What it does

- Maintains a module-level registry of `CliCommand` objects that other plugins or host code populate.
- Assembles a Commander `Command` tree from the registry via `buildProgram` / `runCli`.
- Offers a TTY-aware spinner (`createProgressReporter`, `withProgress`) that degrades to plain log lines in non-interactive environments.
- Ships parsing and formatting helpers for durations (`parseDurationMs`, `formatDuration`) and byte sizes (`formatBytes`).

The plugin object (`cliPlugin`) registers no actions, providers, services, or routes. Its value is the exported API that other code calls.

## Capabilities

| Export | Description |
|--------|-------------|
| `buildProgram(options?)` | Builds a Commander program from all registered commands |
| `runCli(argv?, options?)` | Builds and runs the program against `argv` (defaults to `process.argv`) |
| `registerCliCommand(cmd)` | Register a `CliCommand` in the shared registry |
| `defineCliCommand(...)` | Factory to construct a `CliCommand` |
| `unregisterCliCommand(name)` | Remove a command from the registry |
| `listCliCommands()` | Returns all registered commands sorted by `priority` |
| `addSubcommand(parent, name, desc)` | Attach a subcommand to an existing Commander command |
| `createProgressReporter(deps, options?)` | TTY-aware spinner / progress reporter |
| `withProgress(deps, message, fn)` | Run an async function wrapped with start/success/fail reporting |
| `parseDurationMs(input)` | Parse `"1s"`, `"5m"`, `"2h"`, `"7d"`, bare ms strings |
| `parseTimeoutMs(input?, defaultMs)` | `parseDurationMs` with a default fallback |
| `formatDuration(ms)` | Milliseconds → human-readable string |
| `formatBytes(bytes)` | Bytes → human-readable string |
| `isInteractive()` | Returns `true` when both stdin and stdout are TTYs |

## Installation

```bash
bun add @elizaos/plugin-cli
```

Add to your agent's plugin list:

```typescript
import { cliPlugin } from "@elizaos/plugin-cli";

export const character = {
  plugins: [cliPlugin],
  // ...
};
```

## Registering commands

```typescript
import { defineCliCommand, registerCliCommand, runCli } from "@elizaos/plugin-cli";

registerCliCommand(
  defineCliCommand(
    "greet",
    "Print a greeting",
    (ctx) => {
      ctx.program
        .command("greet")
        .description("Print a greeting")
        .argument("<name>", "Name to greet")
        .action((name) => {
          console.log(`Hello, ${name}!`);
        });
    },
  ),
);

await runCli(process.argv, { name: "myapp", version: "1.0.0" });
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLI_NAME` | No | `"elizaos"` | CLI binary name in help output |
| `CLI_VERSION` | No | `"1.0.0"` | Version string shown by `--version` |

Pass directly to `buildProgram` / `runCli` as options (`{ name, version }`). These values are declared in `agentConfig.pluginParameters` but are not read from `process.env` — the `init` function does not use its config parameter.

## Using the progress reporter

```typescript
import { createDefaultDeps, withProgress } from "@elizaos/plugin-cli";

const deps = createDefaultDeps();

await withProgress(deps, "Fetching data", async () => {
  await fetchSomething();
});
// Prints spinner while running, then "✓ Fetching data" or "✗ <error message>"
```

## Duration parsing

```typescript
import { parseDurationMs } from "@elizaos/plugin-cli";

parseDurationMs("5m");   // { ms: 300000, valid: true, original: "5m" }
parseDurationMs("30s");  // { ms: 30000,  valid: true, original: "30s" }
parseDurationMs("bad");  // { ms: 0,      valid: false, original: "bad" }
```

Supported units: `ms`, `s`/`sec`/`second(s)`, `m`/`min`/`minute(s)`, `h`/`hr`/`hour(s)`, `d`/`day(s)`. Plain integers are treated as milliseconds.

## Notes

- The command registry is module-level state shared across all imports in the same process. In tests, call `clearCliCommands()` in `beforeEach` / `afterEach`.
- All commands must be registered before `buildProgram` / `runCli` is called.
- The progress spinner writes ANSI escape sequences directly to `process.stdout` when running in a TTY; it degrades gracefully in CI and piped output.

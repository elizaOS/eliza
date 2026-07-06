# @elizaos/plugin-cli

CLI framework infrastructure for elizaOS agents: command registration, a TTY-aware progress reporter, and duration/byte formatting helpers.

## Purpose / role

This plugin provides the scaffolding for building a Commander-based CLI on top of an Eliza agent runtime. It ships a module-level command registry that other plugins or host apps populate at startup, plus `buildProgram` / `runCli` entry points that assemble the final CLI. It is **opt-in** — load it explicitly via the agent's plugin list. It registers no actions, providers, services, evaluators, or routes; its value is its exported API.

## Plugin surface

The `cliPlugin` export (default) registers:

| Field | Value |
|-------|-------|
| `name` | `"cli"` |
| `actions` | `[]` |
| `providers` | `[]` |
| `services` | `[]` |
| `routes` | `[]` |
| `config` | `CLI_NAME`, `CLI_VERSION` (see below) |
| `init` | Logs count of registered commands; no persistent side effects |
| `dispose` | Returns immediately |

All real functionality is in the exported API (registry + utils), not in the plugin object's hooks.

## Exported API

### `src/index.ts` — entry point

- `cliPlugin` — the `Plugin` object; default export.
- `buildProgram(options?)` — constructs a `Command` with all registered commands attached; returns the Commander root.
- `runCli(argv?, options?)` — calls `buildProgram`, then `program.parseAsync`. Pass `argv` to override `process.argv`.
- Re-exports `Command` from `commander` for convenience.

### `src/registry.ts` — command registry

Module-level `Map<string, CliCommand>` — shared across all imports in the same process.

| Export | Purpose |
|--------|---------|
| `registerCliCommand(cmd)` | Add a `CliCommand`; warns and replaces on duplicate name |
| `unregisterCliCommand(name)` | Remove by name; returns `boolean` |
| `getCliCommand(name)` | Look up by name |
| `listCliCommands()` | All commands sorted by `priority` (lower = earlier, default 100) |
| `registerAllCommands(ctx)` | Called by `buildProgram`; iterates sorted list, calls each `register(ctx)` |
| `clearCliCommands()` | Empties the registry — test helper only |
| `defineCliCommand(name, description, register, options?)` | Factory for `CliCommand`; accepts optional `aliases` and `priority` |
| `addSubcommand(parent, name, description)` | Thin wrapper: `parent.command(name).description(description)` |

### `src/utils.ts` — utilities

| Export | Purpose |
|--------|---------|
| `DEFAULT_CLI_NAME` | `"elizaos"` |
| `DEFAULT_CLI_VERSION` | `"1.0.0"` |
| `resolveCliName(argv?)` | Derives CLI name from `process.argv[1]` (strips path + extension) |
| `createDefaultDeps()` | Returns `CliDeps` (`console.log`, `console.error`, `process.exit`) |
| `createProgressReporter(deps, options?)` | TTY-aware spinner; falls back to plain log when not a TTY |
| `withProgress(deps, message, fn)` | Runs an async function with spinner; succeeds/fails reporter automatically |
| `parseDurationMs(input)` | Parses `"1s"`, `"5m"`, `"2h"`, `"7d"`, bare ms numbers → `ParsedDuration` |
| `parseTimeoutMs(input?, defaultMs)` | `parseDurationMs` with a fallback default |
| `formatDuration(ms)` | `ms` → human string (`"1.5s"`, `"3.2m"`, `"1.0h"`) |
| `formatBytes(bytes)` | Bytes → `"1.4 MB"` etc. |
| `formatCliCommand(command, options?)` | Formats `elizaos [--profile P] [--env E] <command>` |
| `isInteractive()` | `stdin.isTTY && stdout.isTTY` |

### `src/types.ts` — shared types

`CliContext`, `CliCommand`, `CliRegistrationFn`, `CliPluginConfig`, `CliLogger`, `ProgressReporter`, `ProgressOptions`, `CliDeps`, `ParsedDuration`, `CommonCommandOptions`.

## Layout

```
plugins/plugin-cli/
  src/
    index.ts      Plugin object, buildProgram, runCli, re-exports
    registry.ts   Module-level command registry (Map-backed)
    utils.ts      Progress reporter, duration/byte helpers, CLI name resolution
    types.ts      All shared interfaces and type aliases
  __tests__/
    core-test-mock.ts   vitest setupFile (vi.mock of @elizaos/core logger)
  package.json
  tsconfig.json
  biome.json
  vitest.config.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-cli build          # tsc compile → dist/
bun run --cwd plugins/plugin-cli build:watch    # tsc --watch
bun run --cwd plugins/plugin-cli dev            # alias for build:watch
bun run --cwd plugins/plugin-cli test           # vitest run
bun run --cwd plugins/plugin-cli lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-cli lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-cli format         # biome format --write
bun run --cwd plugins/plugin-cli format:check   # biome format (read-only)
bun run --cwd plugins/plugin-cli typecheck      # tsgo --noEmit
```

## Config / env vars

Declared in `agentConfig.pluginParameters` but **not read from `process.env`** by any source file. Pass values directly to `buildProgram` / `runCli` as call-site options:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLI_NAME` | No | `"elizaos"` | CLI binary name shown in help output |
| `CLI_VERSION` | No | `"1.0.0"` | Version string shown by `--version` |

Pass via `buildProgram({ name: "myapp", version: "2.0.0" })` or `runCli(argv, { name, version })`. The `init` function does not read the config parameter (`_config` is intentionally unused).

## How to extend

### Add a new CLI command

1. Call `defineCliCommand` + `registerCliCommand` before `buildProgram` runs (typically at module load time or in your plugin's `init`):

```typescript
import { defineCliCommand, registerCliCommand } from "@elizaos/plugin-cli";

registerCliCommand(
  defineCliCommand(
    "my-cmd",
    "Does something useful",
    (ctx) => {
      ctx.program
        .command("my-cmd")
        .description("Does something useful")
        .option("--flag", "a flag")
        .action((opts) => {
          const runtime = ctx.getRuntime?.();
          // ...
        });
    },
    { priority: 50 }, // lower = registered earlier
  ),
);
```

2. The command appears in `elizaos --help` automatically once `buildProgram` is called.

### Use the progress reporter in a command

```typescript
import { createDefaultDeps, withProgress } from "@elizaos/plugin-cli";

const deps = createDefaultDeps();
await withProgress(deps, "Doing work", async () => {
  await someLongOperation();
});
```

## Conventions / gotchas

- The command registry is **module-level state** (a `Map`). In a single Node/Bun process all imports share the same registry; in tests always call `clearCliCommands()` in `beforeEach` / `afterEach` to avoid cross-test pollution.
- `buildProgram` iterates `listCliCommands()` at call time. Register all commands before calling `buildProgram`.
- `registerCliCommand` silently replaces on duplicate name (with a `logger.warn`). Use distinct names to avoid accidental overrides.
- The plugin object itself has no persistent resources: `dispose` returns immediately and `init` only logs.
- `createProgressReporter` writes directly to `process.stdout` using ANSI escapes when `isTTY`; it degrades to plain `deps.log` in non-TTY environments (CI, piped output).
- `parseDurationMs` returns `{ valid: false, ms: 0 }` on bad input — always check `valid` before using `ms`.
- Build output goes to `dist/` (`.gitignored`). The package ships only `dist/` — no `src/` in the published tarball.

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

# W2-7 — scenario-runner `extract-params` fix

## Status

Resolved. The `bun --bun packages/scenario-runner/src/cli.ts run …` CLI now
executes scenarios (including pre-existing well-formed ones) instead of
crashing during runtime module resolution.

## Reproduction (pre-fix)

```text
$ bun --bun packages/scenario-runner/src/cli.ts run test/scenarios/lifeops.calendar --run-dir /tmp/repro
[eliza-scenarios] fatal: ResolveMessage: Cannot find module './actions/extract-params.ts' from
  '/Users/shawwalters/milaidy/eliza/node_modules/.bun/@elizaos+agent@2.0.0-beta.1+9a783a7a357f4360/node_modules/@elizaos/agent/src/index.ts'
```

## Root cause

The published `@elizaos/agent@2.0.0-beta.1` npm tarball was packaged with a
broken outer `package.json`:

| field | value | effect |
|-------|-------|--------|
| `main` | `src/index.ts` | points at uncompiled source |
| `bin.eliza-autonomous` | `./src/bin.ts` | points at uncompiled source |
| `exports["."]` | `./src/index.ts` | points at uncompiled source |
| `files` | `["dist"]` | excludes the rest of `src/` from the tarball |

Inside the tarball:

- `./src/` only contains `bin.ts` and `index.ts` (per `files: ["dist"]`,
  these are the bare module-graph roots that snuck through). `src/actions/`,
  `src/services/`, `src/runtime/`, etc. are not in the tarball.
- `./dist/packages/agent/src/` contains the full compiled output (the
  `prepare-package-dist.mjs` build laid the JS down with that nested path so
  TypeScript project-references map cleanly).
- `./dist/package.json` is correct — `main`/`exports` point at
  `./packages/agent/src/index.js`. It was clearly intended for
  `publishConfig.directory: "dist"` to publish from `dist/`, but the tarball
  on the registry instead carries the outer (broken) `package.json` at the
  root with `dist/` nested as a subdir.

Bun extracts that tarball to
`node_modules/.bun/@elizaos+agent@2.0.0-beta.1+<hash>/node_modules/@elizaos/agent/`,
reads the outer `package.json`, and starts loading
`src/index.ts`. The first import — `./actions/extract-params.ts` —
fails because `src/actions/` does not exist in the tarball.

Why this affects scenario-runner: `packages/scenario-runner/` depends
(transitively) on `@elizaos/app-lifeops`, which depends on
`@elizaos/agent: "2.0.0-beta.1"` (registry pin, not `workspace:*`). That
registry pin causes bun to resolve `@elizaos/agent` to the broken cached
tarball inside `app-lifeops` (and several other `app-*` plugins) instead of
the local `packages/agent` workspace package (which is at
`2.0.0-beta.2`).

The local workspace dep on `@elizaos/agent` is wired correctly
(`packages/app-core/package.json` uses `2.0.0-beta.2`, matching the
workspace version), so the top-level
`node_modules/@elizaos/agent` symlink points at `packages/agent`. The
broken copy only surfaces through the nested-dep chain.

## Why not switch every plugin to `workspace:*`?

`scripts/fix-workspace-deps.mjs` exists to do exactly that and is the
repo's canonical fix for this drift. Running `bun run fix-deps` rewrites 378
registry pins to `workspace:*` across the monorepo. But on this checkout an
external linter is reverting every `package.json` edit (`app-lifeops`,
`app-companion`, `app-steward`, …) immediately after the write, so I
cannot land that change here. A future operator with the linter quiesced
should run `bun run fix-deps` to remove the drift permanently.

## Fix

Mirror the existing `scripts/patch-nested-core-dist.mjs` pattern, which
exists for the same shape of bug in `@elizaos/core`. A new
`scripts/patch-nested-agent-dist.mjs`:

1. Walks `node_modules/.bun/@elizaos+agent@<ver>/node_modules/@elizaos/agent/`.
2. Reads the inner `dist/package.json` (which has the correct
   `main`/`bin`/`exports`/`types` pointing at `./packages/agent/src/...`).
3. Reroots every `./packages/agent/src/...` string to `./dist/packages/agent/src/...`
   (i.e. resolved from the package root, not the dist subdir).
4. Replaces only `main`, `types`, `bin`, and `exports` on the outer
   `package.json`. Preserves `dependencies`, `peerDependencies`, etc.
5. Drops the `files: ["dist"]` field — the package is already on disk and
   `files` is meaningless post-extraction; leaving it in is misleading.
6. Idempotent: if `main` already starts with `./dist/`, it skips.

Then wires the script into `package.json#scripts.postinstall` right after
`patch-nested-core-dist.mjs` so it survives `bun install` runs.

## Files changed

- `scripts/patch-nested-agent-dist.mjs` (new)
- `package.json` — `postinstall` chain gains `bun scripts/patch-nested-agent-dist.mjs`

## Verification

Pre-patch the run aborts on the import; post-patch the runner discovers
scenarios, registers plugins, runs the planner, and emits per-scenario
verdicts. Individual scenario assertions still fail for unrelated reasons
(missing planner actions like `calendar_move_instance`, `create_reminder`,
etc.) — those are W2-1..W2-5 territory, not W2-7.

Smoke commands (all executed cleanly, no `extract-params` /
`Cannot find module`):

```text
$ bun --bun packages/scenario-runner/src/cli.ts run test/scenarios/lifeops.calendar --run-dir /tmp/w2-7-verify
[eliza-scenarios] discovered N scenario(s) under test/scenarios/lifeops.calendar
[eliza-scenarios] ▶ calendar.dst-boundary-event-series
[eliza-scenarios] ✗ calendar.dst-boundary-event-series failed (19481ms)
…

$ bun --bun packages/scenario-runner/src/cli.ts run test/scenarios/lifeops.habits --run-dir /tmp/w2-7-verify2
[eliza-scenarios] discovered 18 scenario(s) …

$ bun --bun packages/scenario-runner/src/cli.ts run test/scenarios/lifeops.controls --run-dir /tmp/w2-7-verify3
[eliza-scenarios] discovered 2 scenario(s) …

$ bun --bun packages/scenario-runner/src/cli.ts run test/scenarios/personality/shut_up --run-dir /tmp/w2-7-verify4
[eliza-scenarios] discovered 40 scenario(s) …
```

## Follow-ups

1. **Canonical fix is `workspace:*`.** The `bun run fix-deps:check` CI gate
   reports 378 registry pins that should be `workspace:*`. When the
   external linter is no longer in the way, run `bun run fix-deps` and
   delete `scripts/patch-nested-agent-dist.mjs`. The patch is a stopgap
   that papers over the dep-drift; the dep-drift is the real defect.
2. **Republish `@elizaos/agent`** with the correct `main`/`bin`/`exports`
   pointing into `dist/` (or publish from `dist/` correctly). The current
   tarball is broken for any consumer who pulls it from the registry.
3. **Same shape may apply to other `@elizaos/*` packages.** Worth grepping
   `node_modules/.bun/@elizaos+*/node_modules/@elizaos/*/package.json` for
   `"main": "src/` to find sister bugs proactively.

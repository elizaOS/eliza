# Knip Readiness Follow-Up

Date: 2026-05-12

Scope: read-only audit of Knip setup, package scripts, command blockers, and
high-signal cleanup candidates. No files were changed except this report.

## Commands Inspected / Run

Inspected:

- `package.json`
- `knip.json`
- `scripts/knip-workspaces.mjs`
- `packages/app/knip.json`
- `packages/ui/knip.json`
- `turbo.json`
- `packages/agent/package.json`
- `packages/agent/scripts/build-mobile-bundle.mjs`

Ran:

- `PATH="$HOME/.bun/bin:$PATH" bunx knip --version`
  - Result: `5.88.1`
- `PATH="$HOME/.bun/bin:$PATH" bun run knip -- --help`
  - Result: wrapper help printed successfully.
- `PATH="$HOME/.bun/bin:$PATH" bun run knip -- --list`
  - Result: wrapper enumerated 203 workspace packages.
- `PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast`
  - Result: command ran and failed on `@elizaos/agent`, not on setup.
- `PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter packages/core`
  - Result: command ran and failed on package dependency findings.
- `PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter packages/app-core`
  - Result: command ran and failed on app-core package/config/dependency findings.
- `PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter packages/ui`
  - Result: command ran and failed on four UI dependency findings.
- `PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter packages/app`
  - Result: `@elizaos/app` passed, then the filter continued into `packages/app-core` and failed there because substring filters match multiple paths.
- `PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter plugins/app-lifeops`
  - Result: passed.
- `PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter plugins/plugin-health`
  - Result: failed on many exported public contract symbols.

## Setup Readiness

- The root scripts are present:
  - `knip`: `node scripts/knip-workspaces.mjs`
  - `knip:strict`: `node scripts/knip-workspaces.mjs --fail-on-issues`
- Knip is installed and resolvable from the workspace.
- The wrapper runs Knip once per workspace, preserving root dependency context
  through `--workspace <path>` and `--config knip.json`.
- `bun run knip` should be usable as report-only because the wrapper appends
  `--no-exit-code` unless `--fail-on-issues` is set.
- `bun run knip:strict -- --fail-fast` is usable as the strict gate, but it
  currently fails almost immediately at `packages/agent`.

## Blockers

### P0: Strict Mode Fails On Agent

`bun run knip:strict -- --fail-fast` stops at `@elizaos/agent`.

Observed categories:

- 48 unused files.
- 20 unused dependencies.
- 5 unused devDependencies.
- 3 unlisted dependencies.
- 499 unused exports.
- 123 unused exported types.

This is too much to fix by deleting blindly. The first agent pass must split
findings into:

- dynamic/mobile bundle assets,
- public API compatibility exports,
- true dead files,
- true package manifest defects,
- barrel/re-export noise,
- generated declarations or build artifacts.

### P1: App-Core Has Package Boundary And Manifest Drift

`packages/app-core` fails strict mode with:

- `packages/app-core/vitest.node-sqlite.config.ts` as an unused file.
- 33 unused dependencies.
- 6 unused devDependencies.
- 21 unlisted dependencies.

High-signal examples:

- `vitest.node-sqlite.config.ts` is only referenced by a comment in itself.
- Several UI/runtime packages are listed in app-core but appear to belong in
  `packages/app`, `packages/ui`, test helpers, or scripts.
- Several test-only imports are unlisted in app-core, including
  `@playwright/test`, `playwright`, `puppeteer-core`, `discord.js`,
  `nodemailer`, and several app/plugin packages.

### P1: Core Has Likely Stale Manifest Entries

`packages/core` fails strict mode with unused package dependencies:

- `@ai-sdk/gateway`
- `@ai-sdk/provider`
- `@ai-sdk/provider-utils`
- `@anthropic-ai/sdk`
- `@standard-schema/spec`
- `coding-agent-adapters`
- `eventsource-parser`
- `git-workspace-service`
- `glob`
- `pdfjs-dist`
- `underscore`
- `undici`
- `unique-names-generator`

Unused devDependencies:

- `esbuild`
- `sharp`

Some are referenced only in build externals or comments, which is not enough
to justify package ownership.

### P1: UI Has Small, Actionable Manifest Findings

`packages/ui` fails strict mode with only four findings:

- unused dependencies: `@radix-ui/react-switch`, `drizzle-orm`
- unused devDependencies: `@storybook/react`, `storybook`

`drizzle-orm` appears in `packages/ui/tsconfig.json` path aliases but not in
source imports. Storybook strings/fixtures exist, but no active Storybook entry
was found by Knip.

### P1: Health Fails On Public Contract Exports

`plugins/plugin-health` fails strict mode almost entirely on unused exported
contract constants/types from `src/contracts/lifeops.ts`,
`src/contracts/permissions.ts`, and token/normalization utilities.

This is not an automatic deletion signal. The package is a plugin/domain
contract owner, and many symbols are intended for external consumers. However,
the result does confirm that Knip needs library/public-contract policy before
it can be a strict delete gate for health.

### P2: Package-Local Knip Config Drift

The wrapper always passes root `knip.json`:

```sh
knip --config knip.json --workspace <package>
```

That means package-local configs such as:

- `packages/app/knip.json`
- `packages/ui/knip.json`

are not the active source of truth for the root `bun run knip` and
`bun run knip:strict` commands. They mostly duplicate root workspace entries
today and should either be deleted or intentionally wired into a merge strategy.

## Likely False Positives

### Agent Mobile Stubs

Knip flags every file under `packages/agent/scripts/mobile-stubs/` as unused.
These are referenced dynamically by `packages/agent/scripts/build-mobile-bundle.mjs`
through `path.join(stubsDir, "...")`, so Knip cannot see the static edge.

Do not delete these without passing:

- `bun run --cwd packages/agent build:mobile`
- `bun run --cwd packages/agent build:ios-bun`
- `bun run --cwd packages/agent build:ios-jsc`

Preferred cleanup is to keep the stubs but add explicit Knip ignore policy for
the dynamic bundle assets.

### Agent Public / Compat Re-Exports

Knip flags large re-export surfaces in `packages/agent/src/index.ts`,
`packages/agent/src/api/server.ts`, `packages/agent/src/api/index.ts`, and
multiple `index.ts` barrels.

Some are real cleanup candidates, but some are deliberate compatibility exports
for packaged consumers. The comments in `packages/agent/src/index.ts` say a
published `@elizaos/app-core` alpha bundle depends on restored symbols. Before
removing those, verify the packaged app-core/runtime no longer imports them.

### Plugin-Health Contract Types

The exported `LifeOps*` constants and types in `plugins/plugin-health` are
likely public API, not dead private code. Knip cannot infer external consumers
that import from a package boundary after publication.

Treat these as:

- keep if they are part of the frozen health/LifeOps contract,
- consolidate if duplicated with app-lifeops/shared contracts,
- ignore as public library exports if intentionally external.

### App-Core Test And Script Imports

App-core unlisted dependencies are often in `test/**` or `scripts/**`. They are
still manifest defects, but the fix may be one of:

- move tests/scripts to a package that owns those dependencies,
- add deps/devDeps to app-core,
- narrow app-core Knip project/entry globs,
- delete stale tests/scripts if no longer valid.

## Real Cleanup TODOs

### Knip Configuration

1. Decide whether `knip.json` is the only active config.
2. If yes, delete or fold in `packages/app/knip.json` and
   `packages/ui/knip.json`.
3. Add explicit comments or policy for dynamic mobile stubs and public library
   contract exports instead of burying them in broad ignores.
4. Add package-specific workspace config for high-noise packages before making
   strict Knip a CI gate.
5. Avoid substring filters for broad package names when validating. For example,
   `--filter packages/app` also matches `packages/app-core`.

### Agent

1. Classify the 48 unused files from strict mode.
2. Preserve dynamic mobile stubs or add precise Knip ignores for
   `packages/agent/scripts/mobile-stubs/*.cjs`.
3. Investigate likely true dead files from the unused-file list, including:
   - `packages/agent/src/api/cloud-route-registry.ts`
   - `packages/agent/src/api/server-startup.ts`
   - `packages/agent/src/api/travel-provider-relay-routes.ts`
   - `packages/agent/src/auth/claude-code-stealth-preload.ts`
   - `packages/agent/src/autonomy/index.ts`
   - `packages/agent/src/providers/local-models.ts`
   - `packages/agent/src/providers/self-status.ts`
   - `packages/agent/src/runtime/analysis-mode-flag.ts`
   - `packages/agent/src/runtime/aosp-dflash-adapter.ts`
   - `packages/agent/src/runtime/subagent-output.ts`
   - `packages/agent/src/runtime/task-heartbeat.ts`
4. Collapse unused/test-only barrels where consumers can import canonical files:
   - `packages/agent/src/contracts/index.ts`
   - `packages/agent/src/diagnostics/index.ts`
   - `packages/agent/src/providers/index.ts`
   - `packages/agent/src/shared/index.ts`
   - `packages/agent/src/testing/index.ts`
   - `packages/agent/src/triggers/index.ts`
   - `packages/agent/src/utils/index.ts`
5. Audit generated declarations committed under `packages/agent/src/**/*.d.ts`
   and `packages/agent/src/**/*.d.ts.map`. They look like build artifacts in
   source directories and should be either regenerated elsewhere or removed.
6. Resolve unlisted agent dependencies:
   - `x402-fetch`
   - `@elizaos/plugin-telegram`
   - `node:sqlite` should likely be `ignoreUnresolved`, not a package dep.

### App-Core

1. Delete `packages/app-core/vitest.node-sqlite.config.ts` if the node-sqlite
   test lane is gone; otherwise add a real package script and document it.
2. Move UI-only dependencies out of app-core if their usage belongs to
   `packages/app` or `packages/ui`.
3. Fix test/script dependency ownership for Playwright, Puppeteer, connector
   plugins, `discord.js`, `nodemailer`, and app/plugin imports.
4. Decide whether app-core should include `test/**` and `scripts/**` in Knip
   strict analysis. If yes, make their deps explicit.

### UI

1. Remove `@radix-ui/react-switch` if no switch component imports remain.
2. Remove `drizzle-orm` from `packages/ui/package.json` and tsconfig path
   aliases unless UI still intentionally compiles plugin-sql types.
3. Remove Storybook deps/fixtures/config, or restore real Storybook entrypoints
   and scripts if this package still owns Storybook.

### Core

1. Validate each strict-mode unused dependency against real source imports, not
   build externals/comments.
2. Remove stale deps from `packages/core/package.json` when they are only
   externalized in `packages/core/build.ts`.
3. If a dependency is intentionally optional/public-peer behavior, encode that
   as peer/optional/Knip policy instead of a normal dependency.

### Plugin-Health / LifeOps Contracts

1. Do not delete `LifeOps*` contract exports solely from Knip output.
2. Consolidate duplicated `contract-stubs.ts` files with the canonical owner
   identified in the type duplication report.
3. After consolidation, configure Knip so public contract exports do not block
   strict mode.
4. Preserve the AGENTS.md architecture rule: LifeOps consumes health through
   registries/contracts; LifeOps must not import health internals.

### Repo Artifacts Seen During Audit

`plugins/plugin-device-filesystem/node_modules` exists locally and is about
239 MB. It was encountered by a broad `rg` command because it is under a plugin
directory. It should be included in the generated-artifact cleanup wave if it is
not intentionally checked in.

## Suggested Validation Commands

Use narrow filters first:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter @elizaos/ui
PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter @elizaos/core
PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter @elizaos/app-core
PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter @elizaos/agent
PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter @elizaos/app-lifeops
PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast --filter @elizaos/plugin-health
```

Then run the full report-only pass:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run knip
```

Then run the full strict gate:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run knip:strict -- --fail-fast
```

For cleanup changes, pair Knip with the normal repo gates:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run lint:check
PATH="$HOME/.bun/bin:$PATH" bun run typecheck
PATH="$HOME/.bun/bin:$PATH" bun run build
PATH="$HOME/.bun/bin:$PATH" bun run test
```

For agent mobile-stub decisions, also run:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd packages/agent build:mobile
PATH="$HOME/.bun/bin:$PATH" bun run --cwd packages/agent build:ios-bun
PATH="$HOME/.bun/bin:$PATH" bun run --cwd packages/agent build:ios-jsc
```

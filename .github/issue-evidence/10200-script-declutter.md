# Script declutter — issue #10200 implementation evidence

Companion to [`10200-script-inventory.md`](./10200-script-inventory.md) (the
read-only AC-1 inventory, merged via #10360). That inventory was the evidence
base; **this is the decluttering follow-up it anticipated.** It implements the
four distinctive items the issue triage flagged as still-unmet after #10194 /
#10078 / #10096.

## What shipped

| # | Item (from issue triage) | Status | Where |
|---|---|---|---|
| 1 | `build:core` hand-maintained 27-`--filter` list → maintainable metadata + drift self-test | **done** | `packages/scripts/build-core.mjs`, `build-core-packages.mjs`, `__tests__/build-core.test.ts` |
| 2 | Whole-repo inventory incl. `packages/app/package.json` (the second dense surface) | **done** | `packages/scripts/audit-scripts-inventory.mjs` (+ smoke test) |
| 4a | Root script count was up (peak 204) | **down to 201** | removed `dev:web:ui`, `dev:cloud:full` (proven dups) |
| 4b | Shared `plugin-build.ts` driver had no dedicated self-test (57 adopters) | **done** | `packages/scripts/__tests__/plugin-build.test.ts` |
| 3 | dev-orchestrator / `run-all-tests.mjs` consolidation | **deferred (documented)** | see "Deferred" below |

## 1 — `build:core`: 930-char filter wall → declarative metadata + drift guard

The root `build:core` script — load-bearing (6 CI/deploy workflows + the
`test:server` / `test:client` / `test:plugins` lanes all run it first) — was a
hand-curated wall of flags. A new test-lane dependency had to be appended by
hand; a renamed/removed package would rot it silently.

**Before** (root `package.json`, 930 chars, 27 `--filter=` flags):

```
"build:core": "node packages/scripts/run-turbo.mjs run build --filter=@elizaos/contracts --filter=@elizaos/core --filter=@elizaos/shared --filter=@elizaos/cloud-sdk --filter=@elizaos/cloud-routing --filter=@elizaos/cloud-shared --filter=@elizaos/vault --filter=@elizaos/ui --filter=@elizaos/app-core --filter=@elizaos/plugin-local-inference … (×27)"
```

**After** (36 chars):

```
"build:core": "node packages/scripts/build-core.mjs"
```

The 27 leaf package names now live in `build-core-packages.mjs` (grouped, one per
line, with rationale comments). `build-core.mjs` expands them into the **exact
same** `run-turbo.mjs run build --filter=…` invocation — byte-identical Turbo
behaviour, so every workflow and test lane is unaffected. The set is now
drift-guarded by a self-test.

**Set-equality proof** (new helper vs. the old inline list):

```
$ node -e '…buildCoreTurboArgs()… vs old 27-filter list…'
new count: 27 old count: 27 SET EQUAL: true
```

**Turbo resolves the exact 27-package scope** (parent-pinned turbo against the
worktree):

```
$ turbo run build --filter=@elizaos/… (×27) --dry
• Packages in scope: @elizaos/app-core, @elizaos/cloud-routing, @elizaos/cloud-sdk,
  @elizaos/cloud-shared, @elizaos/contracts, @elizaos/core, @elizaos/plugin-agent-orchestrator,
  … (27 packages) … @elizaos/shared, @elizaos/ui, @elizaos/vault
```

**Drift self-test** (`bun test packages/scripts/__tests__/build-core.test.ts`):
6 pass — every core package resolves to a real workspace package, no dupes,
`@elizaos`-only, `buildCoreTurboArgs` emits one `--filter` per package, root
`build:core` delegates to the driver with **no** re-inlined `--filter` (anti-
regression).

## 2 — Inventory now covers `packages/app` (the second dense surface)

`audit-scripts-inventory.mjs` classified only `packages/scripts/*.mjs` + the
root scripts. It now also classifies all **80** `packages/app/package.json`
scripts by reachability:

```
[audit-scripts-inventory] packages/app/package.json reachability

  category                       scripts
  ---------------------------- ---------
  reachable-from-verify              2     (lint, typecheck — via turbo run fan-out)
  reachable-from-test                0
  reachable-from-build               2     (build, … — via turbo run build)
  reachable-from-ci-workflow        23     (--cwd packages/app <name> + working-directory blocks)
  reachable-from-app-internal        0
  orphan                            53     (build:ios:*, capture:*, preflight:* — dev/maintainer entrypoints)
  TOTAL                             80
```

Reachability edges modelled: `--cwd packages/app <name>` (root + CI), Turbo task
fan-out (`run-turbo run build|lint|typecheck` reaches app's same-named script
unless a positive `@elizaos/` filter excludes app), `working-directory:
packages/app` CI step blocks, app→app `bun run <name>`, and npm `pre`/`post`
lifecycle pairs. "orphan" here means *no automated caller found*, **not** safe to
delete — most are human/maintainer entrypoints, the same as root DEV-ENTRY
scripts; the report says so explicitly.

## 4a — Root script count: 204 (peak) → 203 (#10361) → **201** (this PR)

Removed two **proven byte-duplicate** aliases (evidence-backed by the merged
inventory's "Safe to remove first" list):

| removed | duplicate of | migration |
|---|---|---|
| `dev:web:ui` | `dev` (byte-identical) | use `bun run dev`; 1 doc cell + 2 e2e-config comments redirected |
| `dev:cloud:full` | `dev:cloud` (`bun run dev:cloud`) | use `bun run dev:cloud`; zero callers |

**Kept** (not safe to remove): `test:cloud:playwright` (backs the
`scenario-pr-workflow` guard pinning cloud CI to `packages/app`),
`test:cloud:full` (referenced by `check-live-test-artifact-coverage.mjs`),
`lint:all` (human convenience entrypoint). `harness` was already removed in
#10361.

## 4b — Shared `plugin-build.ts` driver self-test

57 plugin `build.ts` files delegate to `buildPlugin`, which had **no** test.
`packages/scripts/__tests__/plugin-build.test.ts` drives it against throwaway
fixture packages and asserts the **real emitted `dist/` tree** across every
orchestration path: clean / clean:false, `Bun.build` target, file renames,
`flatten`, declaration emit (`dtsProject`), `dtsShims`, `dtsCopies`, externals
auto-derivation, build-failure-throws, and `dtsTolerant`. 9 tests pass,
95.8 % line coverage of `plugin-build.ts`. Plus 2 tests for
`externalsFromPackageJson`.

## Deferred (documented) — item 3: `run-all-tests.mjs` consolidation

Left untouched **on purpose**, consistent with #10194's evidence (it was
deferred there "to keep `verify` green"). `run-all-tests.mjs` is a 1080-LOC
orchestrator that drives *every* test lane (`test`, `test:ci`, `test:e2e`,
`test:server/client/plugins`, …). A rewrite carries a high risk of destabilising
the whole test surface for a payoff (nicer "what ran / what was skipped" output)
that is lower-value than items 1/2/4 and orthogonal to them. Tackling it safely
needs its own focused change with its own lane-by-lane evidence — not a rider on
this PR. Re-file as a standalone issue if pursued.

## Verification

All run locally (worktree shares the parent repo's `node_modules`; full Turbo
builds + `bun run verify` run in CI):

```
# New + extended self-tests (bun test)
$ bun test packages/scripts/__tests__/build-core.test.ts            # 6 pass
$ bun test packages/scripts/__tests__/plugin-build.test.ts          # 9 pass (95.8% cov)
$ bun test packages/scripts/__tests__/audit-scripts-inventory.test.ts  # 6 pass
                                                                    # → 21 pass / 0 fail

# Gating audits already in `verify`
$ node packages/scripts/audit-scripts.mjs            # OK — no orphan/no-op/broken
$ node packages/scripts/audit-scripts.self-test.mjs  # passed
$ node packages/scripts/audit-build-typecheck.mjs    # compiler model consistent

# Lint (biome check, real-path) on all 8 changed code files
$ biome check …                                      # Checked 8 files. No fixes applied.

# build:core delegation + drift
$ node packages/scripts/build-core.mjs --dry  # turbo resolves the exact 27-package scope
```

CI wiring: the three self-tests run in `scenario-pr.yml` (the lane that invokes
`packages/scripts/__tests__` files explicitly, since that dir is outside
workspace test discovery).

Full `bun run verify` / a real `bun run build:core` need the workspace
`node_modules` (absent in the `.claude/worktrees/*` checkout — a documented
constraint) and run in CI on the PR.

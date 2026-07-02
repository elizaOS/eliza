# Issue #11222 - PGlite pid-1 stale lock self-heal

Date: 2026-07-02
Branch: `fix/11222-pglite-pid1-stale-lock`
Base: `origin/develop` at `8bed05c1718a`

## What Changed

- `PGliteClientManager` now writes Linux boot id and `/proc` process start ticks
  into `eliza-pglite.lock` when available.
- Existing locks are no longer trusted on bare PID liveness alone. If the lock
  metadata proves that the currently-live PID started after the lock was
  written, the lock is stale and is reclaimed.
- This covers the container pid-1 crash-loop case: a new container process can
  reuse pid 1, but it cannot have created a lock before it started.

## Regression

Added coverage in
`plugins/plugin-sql/src/__tests__/integration/postgres/pglite-manager-lock.real.test.ts`:

- existing live-lock coverage now preserves the current process identity so a
  long-running owner is still honored even when `createdAt` is old;
- new regression creates a legacy lock whose PID is live but whose `createdAt`
  predates that PID's process generation, then asserts `PGliteClientManager`
  reclaims it and removes the lock file;
- existing non-running-PID and second-manager lock tests still pass.

## Verification

Commands run from `/private/tmp/eliza-11222-pglite-lock` after rebasing onto
current `origin/develop` and running `bun install`.

```bash
bunx vitest run --config vitest.real.config.ts \
  __tests__/integration/postgres/pglite-manager-lock.real.test.ts \
  --testTimeout 60000
```

Run from `plugins/plugin-sql/src`.

Result: pass. `1 passed (1)`, `4 passed (4)`.

```bash
bun run --cwd plugins/plugin-sql test
```

Result: pass. `9 passed (9)`, `50 passed (50)`.

```bash
bun run --cwd plugins/plugin-sql typecheck
```

Result: pass.

```bash
bun run --cwd plugins/plugin-sql lint:check
```

Result: pass. `Checked 180 files`.

```bash
bun run --cwd plugins/plugin-sql build
```

Result: pass. Node ESM, browser ESM, CJS, and declarations built.

```bash
git diff --check origin/develop...HEAD
```

Result: pass.

## Repo-Level Verify

```bash
bun run verify
```

Result: failed before turbo typecheck/lint at `audit:type-safety-ratchet` on
current `origin/develop`, unrelated to this plugin-sql change:

- `as unknown as`: `80 current > 77 baseline`
- ``?? {}``: `379 current > 377 baseline`

The changed production file does not add either ratchet pattern.

## Evidence Applicability

- Live LLM trajectory: N/A; this is storage/locking behavior, not model or agent
  prompt behavior.
- UI screenshots/video/audio: N/A; no UI, native visual, voice, or audio surface
  changed.
- Domain artifact: covered by the real PGlite lock regression. The test writes a
  real `eliza-pglite.lock` in a temporary file-backed data dir, constructs the
  real `PGliteClientManager`, and verifies the stale lock file is removed before
  the manager closes.

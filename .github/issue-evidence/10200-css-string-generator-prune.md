# Issue #10200 - remove no-op UI CSS-string generator

Date: 2026-07-01
Branch: `fix/10200-script-prune`

## Change

- Removed `packages/scripts/generate-css-strings.mjs`.
- Removed the `packages/ui` `generate:css-strings` script.
- Removed no-op generator calls from:
  - `packages/ui` `typecheck`
  - `packages/ui` `build:dist:unlocked`
  - `packages/scripts/dev-all.mjs` prepare commands
  - `packages/agent/scripts/build-mobile-bundle.mjs`
  - `packages/app-core/scripts/desktop-build.mjs`
- Updated `packages/ui/CLAUDE.md` and `packages/ui/AGENTS.md` together.
- Removed the stale `.css.ts` generated-file ignore block from `.gitignore`.

Reason: the generator had an empty target list and there were no checked-in or
generated `packages/ui/**/*.css.ts` files. It added script surface and build output
without producing artifacts.

## Inventory

Before:

- `packages/scripts/*.mjs`: 87 files / 25,912 LOC
- Orphan `packages/scripts/*.mjs`: 27 files / 5,054 LOC

After:

- `packages/scripts/*.mjs`: 86 files / 25,838 LOC
- Orphan `packages/scripts/*.mjs`: 26 files / 4,980 LOC

Command:

```bash
node packages/scripts/audit-scripts-inventory.mjs --json
```

## Validation

```bash
git grep -n "generate-css-strings\\|generate:css-strings\\|CSS string modules" -- ':!.github/issue-evidence/**'
```

Result: no remaining tracked references outside historical evidence.

```bash
find packages/ui -name '*.css.ts' -o -name '*.css.tsx' -o -name '*.css.js'
```

Result: no generated CSS-string files exist.

```bash
bun install --frozen-lockfile --ignore-scripts
node --check packages/scripts/dev-all.mjs
node --check packages/agent/scripts/build-mobile-bundle.mjs
node --check packages/app-core/scripts/desktop-build.mjs
bunx @biomejs/biome@2.5.1 check \
  packages/scripts/dev-all.mjs \
  packages/agent/scripts/build-mobile-bundle.mjs \
  packages/app-core/scripts/desktop-build.mjs \
  packages/ui/package.json
bun run build:core
bun run --cwd packages/ui build
bun run --cwd packages/ui typecheck
bun run audit:scripts
git diff --check
```

Results:

- `node --check`: passed for all three modified JS build scripts.
- Biome focused check: passed.
- `bun run build:core`: passed, 64 successful / 64 total.
- `bun run --cwd packages/ui build`: passed; `verify-package-runtime-exports` verified 40 runtime exports.
- `bun run --cwd packages/ui typecheck`: passed.
- `bun run audit:scripts`: passed.
- `git diff --check`: passed.

Root verify:

```bash
bun run verify
```

Blocked before this change's lanes by existing type-safety ratchet drift:
`as unknown as: 108 / 77`. The reported files are outside this PR scope
(`packages/feed`, `packages/agent`, `packages/app-core`, plugin bridge/cloud files).

## Screenshots / Recording

N/A. This is a repository build/support-script cleanup with no UI runtime behavior or
pixels to review. The reviewable artifacts are the inventory counts, actual package
build/typecheck output, script syntax checks, and audit output above.

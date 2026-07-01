# #10200 package-script inventory reachability

Issue: https://github.com/elizaOS/eliza/issues/10200

PR slice: make `packages/scripts/audit-scripts-inventory.mjs` account for
workspace package-local `package.json` scripts that directly invoke
`packages/scripts/*.mjs` helpers.

## Problem found

The existing inventory only modeled root scripts, CI workflows, file-to-file
references, and the `packages/app/package.json` surface. That left package-local
helpers mislabeled as `orphan` even when they are active package commands.

Concrete example from clean `origin/develop` at `534413811a2`:

```json
{
  "file": "run-bash-darwin-only.mjs",
  "loc": 55,
  "category": "orphan"
}
```

That was false: `packages/native/ios-deps/package.json` calls the wrapper from
eight iOS native dependency scripts.

## What changed

- Added a new file reachability category:
  `reachable-from-package-script`.
- Scans checked-in package-local `package.json` scripts, excluding generated
  trees like `node_modules`, `dist`, `.turbo`, reports, coverage, and benchmark
  outputs.
- Records concrete caller metadata per file in the JSON inventory:
  `{ packageJson, script }`.
- Tightened file-name matching so short script names like `dev.mjs` are not
  accidentally matched inside longer names such as `cloud-api-dev.mjs`.
- Added a regression test proving `run-bash-darwin-only.mjs` is package-script
  reachable through `packages/native/ios-deps/package.json`.

## Inventory delta

Baseline on `origin/develop` at `534413811a2`:

```json
{
  "totalFiles": 86,
  "orphanFiles": 26,
  "orphanLoc": 4980,
  "filesByCategory": {
    "reachable-from-verify": 17,
    "reachable-from-test": 2,
    "reachable-from-build": 2,
    "reachable-from-ci-workflow": 39,
    "orphan": 26
  }
}
```

After this slice:

```json
{
  "totalFiles": 86,
  "totalLoc": 25922,
  "orphanFiles": 18,
  "orphanLoc": 3940,
  "filesByCategory": {
    "reachable-from-verify": 17,
    "reachable-from-test": 2,
    "reachable-from-build": 2,
    "reachable-from-ci-workflow": 39,
    "reachable-from-package-script": 8,
    "orphan": 18
  },
  "packageScriptFileReferences": 246
}
```

Files now classified as `reachable-from-package-script`:

- `copy-package-assets.mjs`
- `ensure-tsc-nested-output-dir.mjs`
- `flatten-tsc-package-output.mjs`
- `prepare-package-dist.mjs`
- `remove-source-build-artifacts.mjs`
- `run-bash-darwin-only.mjs`
- `verify-package-runtime-exports.mjs`
- `with-package-build-lock.mjs`

`dev.mjs` remains `orphan` after the stricter boundary matcher, so
`cloud-api-dev.mjs` no longer creates a false package-script hit.

## Validation

```bash
bun test packages/scripts/__tests__/audit-scripts-inventory.test.ts
```

Result: 7 pass, 0 fail, including the package-script reachability regression.

```bash
bunx @biomejs/biome@2.5.1 check \
  packages/scripts/audit-scripts-inventory.mjs \
  packages/scripts/__tests__/audit-scripts-inventory.test.ts
```

Result: passed.

```bash
node --check packages/scripts/audit-scripts-inventory.mjs
bun run audit:scripts:inventory
git diff --check origin/develop...HEAD
```

Result: all passed. The normal inventory alias printed the new
`reachable-from-package-script` bucket and wrote `reports/scripts-inventory.json`
(gitignored).

```bash
bun install --frozen-lockfile --ignore-scripts
bun run verify
```

Install completed without lockfile changes. `bun run verify` still stops at the
pre-existing repository type-safety ratchet before this PR's typecheck/lint
lanes:

```text
[type-safety-ratchet] as unknown as: 108 / 77
[type-safety-ratchet] unsafe cast baseline exceeded
```

The reported files are outside this slice (`packages/feed`, `packages/agent`,
`packages/app-core`, `packages/cloud`, and `plugin-capacitor-bridge`).

Screenshots/screen recording: N/A. This is a repository support-script inventory
change with no UI, app runtime, native surface, or visual output.

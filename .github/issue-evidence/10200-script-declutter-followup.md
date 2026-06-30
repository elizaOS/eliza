# Script declutter — review-driven hardening (issue #10200, follow-up)

Follow-up to the merged #10384 (`07b769e4e02`). An adversarial multi-agent
review of that diff surfaced one CI blocker + three real quality gaps; a
maintainer already fixed the blocker on `develop` (the `TSC_BIN` resolution), so
this PR (a) makes that fix robust and (b) lands the three remaining quality
items the review confirmed.

## What this PR changes

### 1. `TSC_BIN` resolution made layout-independent
`develop` resolves `tsc` as `resolve(import.meta.dir, "..", "node_modules",
"typescript", "bin", "tsc")` — a fixed offset that holds in a fresh CI checkout
but **breaks in a git worktree** (no sibling `node_modules`) or any non-hoisted
layout. Replaced with `createRequire(import.meta.url).resolve("typescript/bin/tsc")`
(with the old path as a fallback), which follows real node module resolution and
works in CI, in a worktree, and standalone. The invocation (`node ${TSC_BIN}`) is
unchanged, so the 57 production plugin builds are unaffected.

### 2. `externals` self-test now *proves* externalization (was tautological)
The merged test declared `node-fetch` as a dep and asserted the bundle
`toContain("node-fetch")` — but the dep is never installed, so the only outcomes
were "import specifier survives" (pass) or "build throws" (error); it could never
observe an inlined module, and would pass even if externalization were deleted
from `buildPlugin`. Replaced with a **real installed marker dependency**: under
`externals:"auto"` the bundle must contain the bare import but **not** the marker
body (externalized); under `externals:[]` it must contain the marker body
(inlined). That distinguishes externalized from bundled.

### 3. Stronger declaration-emit coverage
- `dtsTolerant` test now provokes a **genuine** `tsc` failure (real compiler,
  TS5058 missing project) and asserts the tolerant **warning fired** (spy on
  `console.warn`) — not just that output files are absent (which also held when
  `tsc` simply never ran).
- Added `dtsEmitDeclarationOnly` (the one behavior-selecting branch with no
  coverage; used by 10+ real plugins), a tsc-free `renames`+`flatten` case (so a
  `moveTreeContents`/rename regression is caught without a compiler), and a
  strict-default `dtsProject`-rejects case. 12 `buildPlugin` cases + 2
  `externalsFromPackageJson`; 100 % function coverage of `plugin-build.ts`.

### 4. `turboFanoutTasks` parses Turbo dependency selectors correctly
The inventory tool's positive-filter regex `(@elizaos\/[a-z0-9.-]+)` swallowed
the trailing `...` of `--filter=@elizaos/app...` and missed the leading `...` of
`--filter=...@elizaos/core` — both Turbo selectors that *include* the named
package. Now strips a leading/trailing `...` before the equality check. (Latent:
no wrong output today, but the classifier was objectively wrong.)

### 5. `build-core.mjs` actionable output
Prints the package count on start and, on a turbo failure, the exact
`bun run build:core` re-run command (+ a `bun install` hint on spawn failure) —
the issue's "what ran / why blocked / exact next command" AC for the script this
work introduced.

## Verification

Run under a stripped CI-shape PATH (`env -i PATH=<node>:<bun>:/usr/bin:/bin`, no
`node_modules/.bin`) to prove the `TSC_BIN` resolution holds on a clean runner
and in this worktree:

```
$ bun test packages/scripts/__tests__/plugin-build.test.ts            # 12 pass, 100% func cov
$ bun test packages/scripts/__tests__/build-core.test.ts              # 6 pass
$ bun test packages/scripts/__tests__/audit-scripts-inventory.test.ts # 6 pass
                                                                      # → 24 pass / 0 fail
$ node packages/scripts/audit-scripts.mjs           # OK
$ node packages/scripts/audit-build-typecheck.mjs   # compiler model consistent
$ biome check <changed files>                        # clean
# turboFanoutTasks: @elizaos/app... → [@elizaos/app]; ...@elizaos/core →
#   [@elizaos/core]; !@elizaos/electrobun → []   (negative filters excluded)
```

The review itself: 5 parallel reviewers → per-finding adversarial verification →
synthesis; 16 raw findings, 10 confirmed (1 blocker since fixed on develop, 3
acted on here, the rest nits/skips with recorded rationale).

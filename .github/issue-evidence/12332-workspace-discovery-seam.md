# #12332 — Script decoupling foundation: shared workspace/submodule discovery seam

Phase 0 of the script-decoupling effort (#12189). Adds a single, zero-dependency
discovery seam the script layer can read instead of each script carrying its own
glob walker. **No existing scripts were migrated** — that is phase 1 (#12333).

## What changed

New files (only):

- `packages/scripts/lib/workspaces.mjs` — exports exactly:
  - `expandWorkspaceGlobs(patterns, opts)` — npm/Bun `workspaces` glob expansion:
    `*` = one segment, `**` = any depth (incl. base dir), leading `!` subtracts
    (exclude-wins, last-match-wins). Generalizes the proven expander from
    `packages/scripts/turbo-cache-key.mjs` and adds `**` support.
  - `listWorkspaceDirs(opts)` — root `package.json` `workspaces` expanded, kept
    only where a `package.json` exists.
  - `listPackages(opts)` — maps each dir to `{ name, dir, packageJson }`.
  - `listSubmodules(opts)` — parses root `.gitmodules` into
    `{ path, url, branch, initialized }`.
  - `opts.repoRoot` overrides the auto-discovered repo root; dependency-free
    (node builtins + reading `package.json` / `.gitmodules`).
- `packages/scripts/lib/workspaces.d.ts` — typed signatures for the four exports.
- `packages/scripts/__tests__/workspaces-lib.test.ts` — synthetic glob-semantics
  tests + live-repo parity tests.

## Verification (real output)

### `bun test packages/scripts/__tests__/workspaces-lib.test.ts`

```
-------------------------------------|---------|---------|-------------------
File                                 | % Funcs | % Lines | Uncovered Line #s
-------------------------------------|---------|---------|-------------------
All files                            |  100.00 |   96.84 |
 packages/scripts/lib/workspaces.mjs |  100.00 |   96.84 | 53-54,61-62
-------------------------------------|---------|---------|-------------------

 15 pass
 0 fail
 16 expect() calls
Ran 15 tests across 1 file.
```

Coverage covers: simple `*`, nested `*/*`, `**` (incl. base dir), negation
(`!packages/feed` excluded), later-positive re-add, hidden/`node_modules`/`dist`
dirs skipped, dirs without `package.json` skipped, name mapping, `.gitmodules`
parsing with init state, absent-`.gitmodules` → `[]`, plus live-repo parity:
`@elizaos/plugin-sql` present at `plugins/plugin-sql`, `packages/feed` excluded,
no duplicate package names, `listSubmodules()` paths == `.gitmodules` paths.

### Live parity sanity

`node -e "import('./packages/scripts/lib/workspaces.mjs').then(...)"`:

```
plugin-sql dir: plugins/plugin-sql
feed excluded (exact packages/feed present): false
submodules: [
  { path: plugins/plugin-local-inference/native/llama.cpp, url: https://github.com/elizaOS/llama.cpp.git, branch: main, initialized: false },
  { path: plugins/plugin-local-inference/native/whisper.cpp, url: https://github.com/ggerganov/whisper.cpp.git, branch: master, initialized: false },
  { path: plugins/plugin-agent-orchestrator/vendor/opencode, url: https://github.com/elizaOS/opencode.git, branch: dev, initialized: false },
  { path: packages/research/robot/vendor/asimov-1, url: https://github.com/asimovinc/asimov-1.git, branch: main, initialized: false },
  { path: upstreams/electrobun, url: https://github.com/elizaOS/electrobun.git, branch: develop, initialized: false }
]
```

(Submodules read `initialized: false` in this fresh worktree because they are
un-checked-out gitlink placeholders — the field flips true once a working tree
is present.)

### Lint (workspace biome, pinned version)

```
$ ./node_modules/.bin/biome lint packages/scripts/lib/workspaces.mjs packages/scripts/lib/workspaces.d.ts packages/scripts/__tests__/workspaces-lib.test.ts
Checked 3 files in 1020ms. No fixes applied.
```

### Typecheck (new .d.ts + test)

```
$ ./node_modules/.bin/tsc --noEmit --skipLibCheck --strict --ignoreConfig --types bun --allowJs packages/scripts/lib/workspaces.d.ts packages/scripts/__tests__/workspaces-lib.test.ts
EXIT=0
```

### Error-policy ratchet (new J3 annotations)

```
$ bun run audit:error-policy-ratchet
[error-policy-ratchet] base origin/develop (...); 0 changed production source file(s)
[error-policy-ratchet] no new fallback-slop in touched files
```

Note: the full `bun run verify` runs the entire turbo typecheck/lint graph plus
several audits over ~279 workspaces; the targeted commands above cover the new
files. The one pre-existing `audit:scripts` finding
(`audit:error-policy-ratchet:self-test` orphan root script) exists on
`origin/develop` and is unrelated to this change.

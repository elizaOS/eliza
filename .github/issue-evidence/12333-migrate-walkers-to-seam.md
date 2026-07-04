# #12333 — Migrate duplicated workspace walkers to the shared seam

Behavior-preserving migration of duplicated workspace/package glob walkers onto
`packages/scripts/lib/workspaces.mjs` (`expandWorkspaceGlobs`, `listWorkspaceDirs`,
`listPackages`), plus the 5 copy-pasted `findWorkspaceRoot` helpers folded into
`packages/scripts/lib/repo-root.mjs`.

Each migration is proven identical by capturing the pre-migration walker's output
and the post-migration seam output and diffing them (order-insensitive where the
caller doesn't depend on order). The one intended behavior change —
`fix-workspace-deps` no longer scanning the excluded `packages/feed` monorepo —
is proven to be the ONLY difference for that file.

N/A for UI screenshots, model trajectories, audio, and domain artifacts
(script-layer refactor).

---

## Seam bug fixed first (prerequisite)

`expandPositiveGlob` applied the hidden/build-dir skip only inside `**`
(`walkDirs`); an explicit `*` segment enumerated every child, so a build-output
dir that carries a `package.json` marker leaked in as a "workspace" — concretely
`packages/examples/cloud/clone-ur-crush/.next` (a Next.js `{"type":"commonjs"}`
marker), which bun install itself ignores.

Fix: extract `isTraversableChild(name)` and apply it uniformly to `*`, `**`, and
the recursive walk. Added a regression test.

```
# live-repo leak check, before vs after the seam fix
BEFORE: TOTAL workspace dirs: 280   LEAKED hidden/build dirs (1): packages/examples/cloud/clone-ur-crush/.next
AFTER:  TOTAL workspace dirs: 279   LEAKED hidden/build dirs (0):
```

Seam tests (incl. the new `*`-skip case): `16 pass, 0 fail`.

---

## 1. `fix-workspace-deps.mjs` — the negation-ignoring walker (documented fix)

Local `expandPattern`/`collectWorkspaceDirs` treated a leading `!` as a literal
path segment that never matched, so `!packages/feed` was ignored and
`packages/feed` (+ its whole nested monorepo) was scanned via `packages/*`.
Migrated to `listWorkspaceDirs` (which honors negation); caller keeps its local
"always include the repo root" policy.

Enumeration dir-set diff (before = local walker, after = seam + root):

```
81d80
< packages/feed
```

Exactly one line removed — the excluded feed root. The `packages/feed/packages/*`,
`packages/feed/apps/*`, `packages/feed/tools/*` members stay (they are positive
workspace patterns = bun install truth).

`--check` output: scan count `281 -> 280` (feed root no longer scanned; it had no
dep issues), and the reported issue SET is byte-for-byte identical
(order-insensitive):

```
=== issue lines only, sorted, diff ===
(empty — ISSUE SET IDENTICAL)
```

---

## 2. `turbo-cache-key.mjs`

Local `workspaceGlobToRegExp`/`expandWorkspaceGlob`/`listWorkspaceDirs` replaced
with the seam. The exported `listWorkspaceDirs` keeps its longest-path-first sort
(load-bearing for `owningWorkspace`, which must attribute a file to its
most-specific enclosing workspace).

```
turbo-cache-key listWorkspaceDirs before=279 after=279
diff before after -> IDENTICAL (order-sensitive, longest-first)
```

Tests: `turbo-cache-key.test.ts` 5 pass, 0 fail.

(Note: a full `turbo-cache-key --list`/`--json` run is slow in this large
worktree because its unrelated `listGitFiles` hits `spawnSync`'s 1 MB `maxBuffer`
on `git ls-files -z` and falls back to a full FS walk — a pre-existing issue in
`listGitFiles`, not touched by this migration. The migration touches only
`listWorkspaceDirs`, whose output is proven identical above.)

---

## 3. `run-examples-benchmarks.mjs`

Local regex matcher + recursive `collectPackageJsons` + `isWorkspaceMember`
replaced with `listPackages`, scoped locally to `packages/examples` /
`packages/benchmarks` and filtered by "declares the requested script".

Discovered package set, before vs after, per script name:

```
lint:      before=47  after=47  IDENTICAL SET
typecheck: before=53  after=53  IDENTICAL SET
build:     before=47  after=47  IDENTICAL SET
```

---

## 4. `generate-dist-paths-config.mjs`

Local `workspacePatternToRegExp` include/exclude matcher +
`childWorkspaceDirs`/`expandWorkspacePattern`/`workspacePackageManifests` replaced
with `listWorkspaceDirs`; the redundant `matchesWorkspace` re-check in
`packageAliases` dropped (every manifest now comes from the seam).

Manifest set: `before=279 after=279`, IDENTICAL. Strongest proof — the generated
`tsconfig.dist-paths.json` is byte-for-byte identical when produced by the
original vs migrated walker:

```
diff gdpc-out-original.json gdpc-out-migrated.json
GENERATED CONFIG BYTE-IDENTICAL   (204 path aliases)
```

(Pre-existing note: `--check` reports the committed `tsconfig.dist-paths.json` as
stale on current `develop` because packages were added after it was last
committed — the ORIGINAL generator reports the same staleness, so it is not a
regression from this migration and is out of scope for #12333.)

---

## 5. `audit-turbo-build-deps.mjs`

Local `expandGlob` + `buildWorkspaceMap` replaced with `listPackages`
(name -> absolute dir). `readdirSync`/`statSync` remain for the source scan.

```
name->dir map before=279 after=279  IDENTICAL
audit output before vs after -> IDENTICAL  ("✓ no phantom #build dependency edges", exit 0)
```

---

## 6. `run-all-tests.mjs`

Local `expandWorkspacePattern` + `collectPackageJsonPaths` replaced with the
seam. The deliberate **whole-subtree** exclusion of every `!`-negated root
(feed's nested members can't resolve under a plain root install and belong to
feed's own CI lane) stays a **caller-local policy filter**, computed from
`expandWorkspaceGlobs([negated])` and applied prefix-wise over the seam output.
`ADDITIONAL_PACKAGE_DIRS` unchanged.

Package set: `before=254 after=254`, IDENTICAL (0 under `packages/feed`, as before).
Full `run-all-tests --plan=text` output is byte-for-byte identical for both lanes:

```
lane=pr:          PLAN IDENTICAL   (266 tasks, 241 packages, parallel-safe=238 serial=28)
lane=post-merge:  PLAN IDENTICAL
```

---

## 7. `findWorkspaceRoot` x5 -> `lib/repo-root.mjs`

The five identical walk-up-to-`workspaces` helpers in
`ensure-tsc-nested-output-dir`, `flatten-tsc-package-output`,
`rewrite-dist-relative-imports-node-esm`, `verify-package-runtime-exports`, and
`with-package-build-lock` folded into one exported `findWorkspaceRoot(startDir)`
(sync). All callers pass `process.cwd()`, for which the fallback is identical to
the old `process.cwd()` literal.

```
findWorkspaceRoot(cwd) -> /…/<repo root>   (correct)
verify-package-runtime-exports packages/logger:   original and migrated both print the
  same "1 missing runtime export ./dist/index.js" and exit 1
```

---

## Deferred (NOT migrated — different query, not a seam duplicate)

Each was inspected and left in place with a proven reason:

- **`ensure-workspace-symlinks.mjs`** — hardcoded `WORKSPACE_DIRS` walked to
  depth 3 over arbitrary roots (not the `workspaces` globs). The seam's member
  set differs: it would STOP linking 7 `packages/benchmarks/*` packages (the
  hardcoded walk catches them via a depth-3 `packages` sweep; the globs list only
  specific benchmark subdirs) and newly link 15 others. That is a behavior change
  with a regression risk, not a behavior-preserving swap. `before(@elizaos)=231
  after=239`, 7 only-in-before. Deferred.
- **`prepare-package-dist.mjs`** — `collectWorkspaceVersions` is an **unbounded**
  recursive walk of `packages/` + `plugins/` that intentionally collects nested,
  non-workspace `package.json`s (e.g. `plugins/plugin-sql/src/package.json`) for
  publish-time version resolution. `before COUNT=303` vs seam `274`. Different
  query. Deferred.
- **`replace-workspace-versions.js`** — reads globs from **`lerna.json`**
  (`packages`), a deliberately narrower publish set, not the root `workspaces`.
  Different source of truth. Deferred.
- **`ensure-native-plugins-linked.mjs`** — single-dir `readdirSync` prefix scan
  of `packages/native/plugins` for `plugin-native-*` (a plugin subset over a
  non-workspace dir), not a workspace-glob walker. Deferred.
- **`scripts/testing-coverage-matrix.mjs`** — derives package dirs from
  `git ls-files` (every dir with a `package.json`, by design), not from the
  `workspaces` globs. It only reads the negations as a small "in-CI" stat helper.
  No `listWorkspaceDirs`-shaped duplicate. Deferred.

---

## Verification summary

```
bun test packages/scripts/__tests__/workspaces-lib.test.ts packages/scripts/__tests__/turbo-cache-key.test.ts
  21 pass, 0 fail

node packages/scripts/audit-turbo-build-deps.mjs            -> ✓ exit 0
node packages/scripts/run-all-tests.mjs --plan=text --no-cloud  -> byte-identical to original
node packages/scripts/run-examples-benchmarks.mjs <script>  -> identical discovery set
node packages/scripts/fix-workspace-deps.mjs --check        -> issue set identical (feed root excluded)
generate-dist-paths-config: generated config byte-identical (original vs migrated)
findWorkspaceRoot: resolves the repo root; migrated scripts behave identically
```

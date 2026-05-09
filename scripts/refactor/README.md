# Source-to-Dist Refactor Scripts

A hard-cutover toolkit that moves the monorepo from "source-distributed everywhere" to the standard "src for dev, dist for publish" model documented in the implementation plan.

## Usage

Every script defaults to **dry-run mode** and prints what it would do. Re-run with `--apply` to actually mutate the worktree.

```bash
# Dry-run a single phase
bun scripts/refactor/p0-break-cycles.mjs

# Apply a single phase
bun scripts/refactor/p0-break-cycles.mjs --apply

# Dry-run the whole cutover
bun scripts/refactor/run-all.mjs

# Apply the whole cutover (one shot)
bun scripts/refactor/run-all.mjs --apply

# Apply and commit each phase separately
bun scripts/refactor/run-all.mjs --apply --commit-per-phase
```

## Flags (every script)

| Flag | Effect |
|---|---|
| (none) | Dry-run. Print every change. Exit 0 if clean, 1 if errors. |
| `--apply` | Actually perform the changes. |
| `--quiet` | Suppress per-file output; print only summary. |
| `--verbose` | Print extra detail (full diffs, import-by-import progress). |
| `--no-color` | Disable ANSI color in output (for CI logs). |

## Phases

| File | Phase | What it does |
|---|---|---|
| `p0-break-cycles.mjs` | P0 | Extract `ElizaConfig` + cloud helpers from `@elizaos/agent` → `@elizaos/cloud-sdk`/`@elizaos/shared`. Add cloud-route registry to invert agent ↔ plugin-elizacloud edge. Remove app-lifeops from agent's deps. |
| `p1-move-app-core-files.mjs` | P1a | Move React components/hooks/state from `@elizaos/app-core/src/**` → `@elizaos/ui/src/**`. Move pure types/utils → `@elizaos/shared/src/**`. |
| `p1-rewrite-app-core-imports.mjs` | P1b | Rewrite ~10K consumer imports of `@elizaos/app-core/<subpath>` to new homes. |
| `p1-collapse-app-core-exports.mjs` | P1c | Replace 100+ subpath exports in `packages/app-core/package.json` with single barrel `.` export. |
| `p2-standardize-plugin-builds.mjs` | P2 | Add `tsc --emitDeclarationOnly` step to 28 plugins missing `.d.ts`. Create shared `tsconfig.build.shared.json`. |
| `p3-flip-package-main.mjs` | P3 | Flip `main`/`module`/`types`/`exports` from `src/` to `dist/` for 37 packages. |
| `p4-publish-pipeline.mjs` | P4 | Create `publish-from-dist.mjs`. Delete obsolete `restore-workspace-refs.js` and `replace-workspace-versions.js`. |
| `p5-tsconfig-paths.mjs` | P5 | Rename `tsconfig.dist-paths.json` → `tsconfig.dist-paths.json`. Expand to cover all built packages. |
| `p6-turbo-json.mjs` | P6 | Add explicit turbo build entries for newly-built packages. |
| `verify.mjs` | P7 | Run `bun install`, `bun run build`, `bun run typecheck`, `bun run typecheck:dist`, `bun run test`. Report pass/fail per check. |
| `run-all.mjs` | All | Orchestrator. |

## Recommended workflow

1. **Dry-run everything**: `bun scripts/refactor/run-all.mjs > /tmp/refactor-dry.log`
2. **Read the log** carefully. Eyeball the moves, the import rewrites, the package.json diffs.
3. **Apply on a fresh branch**:
   ```bash
   git checkout -b refactor/src-to-dist
   bun scripts/refactor/run-all.mjs --apply --commit-per-phase
   ```
4. **Run verify**: `bun scripts/refactor/verify.mjs` — fix anything that fails.
5. **Manual cleanup**: the codemod won't catch 100% of edge cases. Expect to fix dynamic imports, type-only re-exports, and CSS `@source` paths by hand.

## Rollback

If the apply goes sideways, every phase produces a separate commit (when run with `--commit-per-phase`). To undo phase N: `git reset --hard <commit-before-phase-N>`. If you ran in single-commit mode: `git reset --hard HEAD~1`.

## Safety properties

- **Idempotent**: re-running an already-applied phase is a no-op.
- **Pre-flight checks**: each script verifies its preconditions and refuses to run on a dirty / wrong branch unless forced.
- **Atomic per-file**: file moves and writes use `fs.rename`/`writeFileSync` (no partial writes).
- **Git-aware**: uses `git mv` for moves so history is preserved.

## Known gaps the scripts can't fully automate

- **Dynamic imports** (`await import("@elizaos/app-core/...")` constructed from variables) — the codemod skips these; manual review needed.
- **CSS `@source` paths** in Tailwind configs — the script lists candidates but doesn't rewrite (high false-positive risk).
- **Test snapshot files** that hardcode old paths — regenerate with `bun run test -- -u`.
- **External docs** referencing `@elizaos/app-core/<subpath>` — manual update.

Each script's stdout flags these as "MANUAL REVIEW" with file paths.

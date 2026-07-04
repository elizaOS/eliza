# Issue #12904 Feed script normalization evidence

## Scope

Feed package-script normalization for `packages/feed` after the non-Feed
peripheral package slice.

## Changes verified

- Added the standard script verbs across 26 Feed package manifests:
  `lint`, `lint:check`, `lint:fix`, `format`, `format:check`, `typecheck`
  where TypeScript applies, and `clean` where build artifacts are produced.
- Removed fake-success/no-op behavior from scoped Feed package scripts.
- Kept `build` for artifact-producing commands only, including real Forge
  commands for `packages/contracts`.
- Added a real Bun test for `packages/examples/local-a2a-server`.
- Split typecheck from declaration-emitting build steps for `packages/a2a`,
  `packages/mcp`, and `packages/pack-default`.
- Kept Feed guide files untouched because `packages/feed/CLAUDE.md` says they
  are generated from `.ruler/`.

## Command evidence

```text
$ node <feed package script contract audit>
packages=26 issues=0
```

```text
$ while IFS= read -r p; do bun run --cwd "$p" lint:check ...; done
feed-lint-ok
```

```text
$ while IFS= read -r p; do bun run --cwd "$p" format:check ...; done
feed-format-ok
```

```text
$ bun run --cwd packages/feed/packages/examples/local-a2a-server test
1 pass
0 fail
4 expect() calls
```

```text
$ bun run --cwd packages/feed/packages/crypto-browserify lint:check
Checked 1 file in 4ms. No fixes applied.

$ bun run --cwd packages/feed/packages/crypto-browserify format:check
Checked 1 file in 3ms. No fixes applied.
```

```text
$ bun run --cwd packages/feed/apps/cli clean
$ bun run --cwd packages/feed/apps/dag-visualizer clean
$ bun run --cwd packages/feed/apps/mobile clean
$ bun run --cwd packages/feed/packages/examples/local-a2a-server clean
$ bun run --cwd packages/feed/packages/sim clean
all exited 0
```

```text
$ git diff --check
exit 0
```

## Blockers / not run

- `bunx tsc -p packages/feed/apps/dag-visualizer --noEmit` reaches the
  package typecheck but this sparse worktree cannot resolve the visualizer's
  third-party dependencies:
  `@xyflow/react`, `@xyflow/react/dist/style.css`, and `@dagrejs/dagre`.
  Local TypeScript issues surfaced before those module-resolution errors were
  fixed in this patch.
- Full `bun run verify` was not run for this Feed-only sparse worktree. The
  focused package script audit plus targeted Feed lint/format/test/clean checks
  were run instead.
- Full Feed source lint is intentionally not introduced in this normalization
  slice because the existing Feed tree has a large unrelated Biome backlog.
  These package scripts validate package metadata/config files for the script
  contract without turning this issue into a broad source-lint cleanup.

## Visual / LLM / logs

- Screenshots and video: N/A, script normalization plus non-visual type/lint
  cleanup only.
- Real-LLM trajectory: N/A, no agent prompt/model behavior changed.
- Backend/frontend logs: N/A, no runtime route or UI flow changed.

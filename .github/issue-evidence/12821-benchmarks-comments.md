# Issue #12821 Evidence: benchmarks Comment Cleanup

## Scope

- Package area: `packages/benchmarks`
- Source set: TS/JS-family files supported by `scripts/assert-comment-only-diff.mjs`
- Excluded: generated/build outputs and vendored `packages/benchmarks/terminal-bench/tasks/**`
- Change type: benchmark-context prose headers and comment-only churn wording cleanup
- Audit after edit: `sourceFiles: 254`, `missingHeaders: 0`, `churnCommentLines: 0`
- Comment-only guard: 90 source files changed, no code-token changes
- Trajectory/screenshot/video/audio/domain artifacts: N/A - comments-only change, zero functional diff machine-checked by `scripts/assert-comment-only-diff.mjs`.

## Verification

```bash
bun run install:light
```

Passed in this reused worktree before the branch switch.

```bash
bun run check:comment-only
```

Passed:

```text
[assert-comment-only-diff] OK — 90 source file(s) changed; every code token identical to origin/develop. Comments only.
```

```bash
git diff --check
```

Passed.

```bash
bun run verify
```

Attempted. The run passed `check:agents-claude`, `audit:type-safety-ratchet`, and `audit:error-policy-ratchet`, then failed during workspace linting on unrelated `@elizaos/tui#lint` diagnostics. Write-mode formatter changes in unrelated packages were restored before commit.

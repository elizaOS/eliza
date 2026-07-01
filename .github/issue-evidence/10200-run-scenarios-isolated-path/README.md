# #10200 run-scenarios-isolated path fix

## Root cause

`packages/scripts/run-scenarios-isolated.mjs` resolved the repository root as
`packages/`, then appended `eliza/packages/scenario-runner/src/cli.ts`. In a
normal checkout that produced a non-existent CLI path:

```text
packages/eliza/packages/scenario-runner/src/cli.ts
```

The wrapper is documented as the per-scenario isolation workaround for the
scenario runner, so this was support-script drift under #10200.

## Fix

- Resolve the repo root two levels above `packages/scripts`.
- Resolve the CLI as `packages/scenario-runner/src/cli.ts`.
- Add a focused regression test that asks the wrapper for its resolved paths and
  asserts the target CLI exists.

## Validation

```bash
bun test packages/scripts/__tests__/run-scenarios-isolated.test.ts
node --check packages/scripts/run-scenarios-isolated.mjs
bunx @biomejs/biome@2.5.1 check \
  packages/scripts/run-scenarios-isolated.mjs \
  packages/scripts/__tests__/run-scenarios-isolated.test.ts
git diff --check
```

All commands passed locally on the PR branch.

## Not applicable

Android/iOS/desktop capture is not applicable: this change touches only a repo
support script and a focused script regression test.

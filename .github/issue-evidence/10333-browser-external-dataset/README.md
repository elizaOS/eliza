# Issue #10333 - plugin-browser external dataset benchmark

Branch: `feat/10333-browser-external-dataset-benchmark`

## What changed

- Added a committed Mind2Web/WebArena-style fixture adapter in `plugins/plugin-browser/src/benchmark/external-dataset.ts`.
- The fixture compiles external dataset rows into the existing `BenchmarkTask` contract.
- The runner still drives actions through `BrowserBenchmarkAdapter`, which dispatches real plugin-browser `BROWSER` workspace commands via `executeBrowserWorkspaceCommand`.
- Added `bun run --cwd plugins/plugin-browser bench:external`.

## Evidence

```bash
bunx vitest run src/benchmark/__tests__/external-dataset.test.ts src/benchmark/__tests__/miniwob-adapter.test.ts
```

Result: 2 test files passed, 8 tests passed.

```bash
bun run typecheck
```

Result: passed in `plugins/plugin-browser`.

```bash
bun run test
```

Result: 25 test files passed, 132 tests passed in `plugins/plugin-browser`.

```bash
bun run bench:external -- --out ../../.github/issue-evidence/10333-browser-external-dataset/external-dataset-oracle-run.json
```

Result: oracle solved 3/3 external dataset fixture episodes on `jsdom-web`.

Primary artifact:

- `external-dataset-oracle-run.json`

## Scope note

This lands the CI-safe external-dataset lane using committed Mind2Web/WebArena-style fixtures. It does not vendor the full public Mind2Web or WebArena corpora; larger corpus downloads and long-running CI gates remain separate infrastructure work.

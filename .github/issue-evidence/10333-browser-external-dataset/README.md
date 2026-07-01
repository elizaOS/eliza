# Issue #10333 - plugin-browser external dataset benchmark

Branch: `fix/10333-browser-benchmark-closeout`

## What changed

- Added a committed Mind2Web/WebArena-style fixture adapter in `plugins/plugin-browser/src/benchmark/external-dataset.ts`.
- The fixture compiles external dataset rows into the existing `BenchmarkTask` contract.
- The runner still drives actions through `BrowserBenchmarkAdapter`, which dispatches real plugin-browser `BROWSER` workspace commands via `executeBrowserWorkspaceCommand`.
- The Mind2Web fixture now exercises CLICK / TYPE / SELECT-style operations, including a `select` action through the shared benchmark action seam.
- Added a real-Chromium external lane and `bun run --cwd plugins/plugin-browser bench:external:chromium`.

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

```bash
bun run --cwd plugins/plugin-browser test:real:external
bun run --cwd plugins/plugin-browser bench:external:chromium
```

Result: oracle solved 3/3 external dataset fixture episodes on real Chromium
(`engine: "chromium"`), including the SELECT step.

Primary artifacts:

- `external-dataset-oracle-run.json`
- `external-dataset-chromium-oracle-run.json`

## Scope note

This lands the CI-safe external-dataset lane using committed Mind2Web/WebArena-style fixtures and gates it in the real Chromium benchmark workflow. It does not vendor the full public Mind2Web or WebArena corpora; those larger corpus downloads / dockerized site farms remain environment-provided inputs rather than repository fixtures.

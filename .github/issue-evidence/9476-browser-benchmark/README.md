# #9476 — a benchmark wired through real plugin-browser

This is the evidence bundle for the one Definition-of-Done deliverable that was
[verifiably missing on `develop`](https://github.com/elizaOS/eliza/issues/9476#issuecomment-4830133507):

> **≥1 benchmark wired through `plugin-browser`** (mirror
> `plugin-computeruse/src/osworld/adapter.ts`), with a committed run artifact.

The other three DoD items (CI-asserted parity matrix, a real-code JSDOM lane, a
typed error contract) already landed. The web benchmarks (Mind2Web, WebShop,
VisualWebBench) all **bypass** plugin-browser via the inference layer — no
benchmark actually drove the BROWSER command surface end-to-end. This closes
that gap.

## What it is

A **MiniWoB++-style** web-interaction benchmark (the canonical web-agent
benchmark — Shi et al. 2017, Liu et al. 2018) whose every action is dispatched
through the **real** `executeBrowserWorkspaceCommand` router — the same
mock-free path the `browser-workspace-web-real-code` lane drives — and whose
reward is computed from **observable DOM state read back through real BROWSER
`get` commands**. No mock service stands in for the browser.

Code: `plugins/plugin-browser/src/benchmark/`
(`adapter.ts` mirrors `plugin-computeruse/src/osworld/adapter.ts`).

| File | Role |
|------|------|
| `types.ts`   | Action / observation / task / report contracts + the engine-agnostic `BrowserCommandExecutor` seam |
| `tasks.ts`   | 6 MiniWoB++ tasks (pure markup, no page scripts) with deterministic per-seed instances + oracle solutions |
| `adapter.ts` | `BrowserBenchmarkAdapter` — `loadTask` / `getObservation` / `executeAction` / `step` / `rewardContext` |
| `policy.ts`  | `OraclePolicy` (deterministic solver) + `NoopPolicy` / `WrongPolicy` (negative baselines) |
| `runner.ts`  | `runBenchmarkSuite` — drives every task×seed episode, scores it, aggregates the report |
| `__tests__/miniwob-adapter.test.ts` | CI-asserted real-code lane (runs in the default `vitest run`) |

## How to reproduce

```bash
# the CI-asserted lane (runs through the real router, no mock):
bun run --cwd plugins/plugin-browser test -- src/benchmark

# the runnable harness → writes a JSON artifact + prints a summary table:
bun run --cwd plugins/plugin-browser bench:miniwob                 # oracle policy
bun run --cwd plugins/plugin-browser bench:miniwob -- --policy noop
bun run --cwd plugins/plugin-browser bench:miniwob -- --policy wrong
```

## Artifacts in this folder (host: Windows 11 Pro, engine `jsdom-web`)

| Artifact | Policy | Result | What it proves |
|----------|--------|--------|----------------|
| `miniwob-oracle-run.json` | oracle | **18/18 solved (100%)** | the suite is solvable end-to-end through real BROWSER commands; every action step records `resultMode: "web"` |
| `miniwob-noop-run.json`   | noop   | **0/18 solved** | doing nothing scores 0 — the reward is grounded in real DOM state, not hard-coded to pass |
| `miniwob-wrong-run.json`  | wrong  | **0/18 solved** | wrong-target / wrong-text near-misses score 0 — the reward discriminates |

Each episode's `trajectory` lists the real commands the adapter dispatched
(`resultMode: "web"` = the live `executeBrowserWorkspaceCommand` router ran it;
a non-null `error` is a real workspace error code, e.g. on a missing element).

The oracle's perfect score next to the noop/wrong zeros is the key signal: the
benchmark exercises the real path **and** the reward function is honest.

## Why JSDOM web mode (not real Chromium) here

Web mode IS plugin-browser's canonical mock-free execution path — the re-open
comment itself credits the JSDOM `browser-workspace-web-real-code` lane as
legitimate "real (non-mock) code". It is deterministic, dependency-free, and
CI-safe, so the committed artifact is reproducible. Reward is read from real DOM
(`get value` / `get checked` / `get url` / `get title`); page scripts are
**not** used (web mode hard-blocks script execution, GHSA-mhhr-9ph9-64j7), so
nothing about the scoring relies on in-page JS.

A **real-Chromium** engine lane, a web-element grounding benchmark, and CI
gating of those heavier lanes are the deferred "Needs CI infra" items — tracked
in the linked follow-up issue so no DoD deliverable is silently dropped.

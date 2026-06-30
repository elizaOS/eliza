# #10333 — the MiniWoB++ benchmark on a REAL Chromium engine

Evidence for the first "Needs CI infra" deliverable spun out of #9476:

> **Real-Chromium engine lane.** Add a `*.real.test.ts` that runs the same
> `BrowserBenchmarkAdapter` suite against a real Chromium via
> puppeteer-core/Stagehand instead of JSDOM web mode — reusing the
> `bunx playwright install chromium` pattern. The adapter is already
> engine-agnostic (`BrowserCommandExecutor`), so this is a new executor + a
> gated lane, not a rewrite.

## What it is

The #9476 benchmark ran the MiniWoB++ suite through the real
`executeBrowserWorkspaceCommand` router in **JSDOM web mode**
(`report.engine === "jsdom-web"`). This adds a second `BrowserCommandExecutor`
that drives the **identical** task suite, oracle sequences, and reward against a
**real Chromium browser** via `puppeteer-core` (`report.engine === "chromium"`)
— the plugin-browser analog of plugin-computeruse's OSWorld `*.real.test.ts`
lanes.

Network is hard-sealed exactly like web mode: only the task's registered
`network route` pages are served (via puppeteer request interception), every
other request is aborted, and the reward is read back from observable DOM state
through real BROWSER `get` commands. No mock stands in for the browser.

| File | Role |
|------|------|
| `src/benchmark/chromium-executor.ts` | `createChromiumBenchmarkExecutor` (puppeteer-core), `launchChromiumBenchmarkBrowser` (one browser per suite), `resolveChromiumExecutablePath` (skip-guard) |
| `src/benchmark/__tests__/miniwob-chromium.real.test.ts` | Gated real lane — oracle solves every task, noop baseline scores 0, on real Chromium |
| `vitest.real.config.ts` | Dedicated config that opts the `*.real.test.ts` lane back in (the root config excludes it) |
| `scripts/run-miniwob-chromium-benchmark.mjs` | Artifact runner (`bench:miniwob:chromium`) |
| `.github/workflows/browser-real-bench.yml` | CI gating — installs Chromium, runs the lane + uploads the run artifacts (nightly + dispatch + on benchmark changes) |

The executor is engine-agnostic by construction: the runner's `makeExecutor`
seam swaps `createWorkspaceBenchmarkExecutor` (jsdom-web) for
`createChromiumBenchmarkExecutor` (chromium) with no change to the tasks,
adapter, policies, reward, or report shape.

## Results (committed artifacts)

Both produced by a real Chromium process on this machine
(`Google Chrome for Testing`, installed via `bunx playwright install chromium`):

| Artifact | engine | policy | solved |
|----------|--------|--------|--------|
| `miniwob-chromium-oracle-run.json` | chromium | oracle | **18 / 18** (100%) |
| `miniwob-chromium-noop-run.json`   | chromium | noop   | **0 / 12** |

The oracle solving every task and the noop baseline solving none — on a real
browser — is the engine-parity proof: identical tasks + identical oracle
sequences + identical reward, two real engines.

## How to reproduce

```bash
# 1. install a real Chromium (the CI lane does this too)
bunx playwright install --with-deps chromium

# 2. the gated engine-parity lane (excluded from the default `vitest run`)
bun run --cwd plugins/plugin-browser test:real-chromium

# 3. regenerate the run artifacts
bun run --cwd plugins/plugin-browser bench:miniwob:chromium --policy oracle --seeds 3
bun run --cwd plugins/plugin-browser bench:miniwob:chromium --policy noop   --seeds 2
```

Without a Chromium binary the lane self-skips (the `describe.skipIf` guard) and
the runner script is a clean no-op, so the un-gated path stays green.

## Visual evidence (real-browser screenshots + recording)

Captured by `bench:miniwob:chromium:record` and the evidence-capture script
against a real Chromium — these are the pixels the agent actually drove, not a
mock render:

- `scorecard.json` — the oracle run's per-task trajectory (each action + its
  real-command `resultMode`), 6/6 tasks solved.
- `<NN>-<task>-start.png` / `<NN>-<task>-solved.png` — each task's start page and
  its post-oracle (solved) state. E.g. `05-click-checkboxes-solved.png` shows
  the agent having checked exactly the requested checkbox and left the rest
  unchecked — the reward criterion, visually confirmed in a real browser.
- `multistep-purchase-walkthrough.gif` — a step-by-step recording of the
  `multistep-purchase` oracle navigating shop home → catalog → buy through the
  real Chromium (reward 1).

## Sibling lane — web-element grounding (also landed)

The second "Needs CI infra" item — a ScreenSpot-Web-style point-in-bbox grounding
benchmark wired through the real browser screenshot + element-bbox path — landed
alongside this one. Its harness (`src/benchmark/web-grounding.ts`), gated lane
(`web-grounding-chromium.real.test.ts`), and visual evidence live under
`.github/issue-evidence/10333-web-grounding/`.

## Still deferred (tracked on #10333)

- External-dataset benchmark (Mind2Web / WebArena) through real plugin-browser
  BROWSER actions.

This needs multi-GB external datasets / dockerized site environments and remains
genuinely CI-infra-gated; this PR lands the real-Chromium engine lane + its CI
gate (plus the web-grounding lane), which the remaining item extends through the
same `BrowserCommandExecutor` seam.

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
other request is blocked, and the reward is read back from observable DOM state
through real BROWSER `get` commands. No mock stands in for the browser.

| File | Role |
|------|------|
| `src/benchmark/chromium-executor.ts` | `createChromiumBenchmarkExecutor` (puppeteer-core: navigate/click/type/check/get/snapshot/**screenshot**/**get box**/**mouse**), `launchChromiumBenchmarkBrowser` (one browser per suite), `resolveChromiumExecutablePath` (skip-guard) |
| `src/benchmark/__tests__/miniwob-chromium.real.test.ts` | Gated MiniWoB++ engine-parity lane — oracle solves every task, noop scores 0, on real Chromium |
| `src/benchmark/grounding.ts` | Web-element grounding harness — `pointInBbox`, `buildWebGroundingSamples` (real render → screenshot → real bboxes), `scoreWebGrounding` (point-in-bbox + real click-path verify), oracle/corner grounders |
| `src/benchmark/__tests__/web-grounding-chromium.real.test.ts` | Gated grounding lane — oracle grounds + clicks every target, corner baseline none |
| `src/benchmark/mind2web.ts` | Mind2Web replay seam — `replayMind2WebTask` (route per-step snapshot → execute CLICK/TYPE/SELECT → verify via `get`), embedded fixture, `loadMind2WebTasks` (gated `MIND2WEB_DATA_DIR` corpus) |
| `src/benchmark/__tests__/mind2web-chromium.real.test.ts` | Gated Mind2Web lane — every step executes + verifies; a wrong selector fails the step |
| `vitest.real.config.ts` | Dedicated config that opts the `*.real.test.ts` lanes back in (the root config excludes them); runs them sequentially (one browser at a time) |
| `scripts/run-{miniwob-chromium,web-grounding,mind2web}-benchmark.mjs` | Artifact runners (`bench:miniwob:chromium`, `bench:grounding:chromium`, `bench:mind2web:chromium`) |
| `.github/workflows/browser-real-bench.yml` | CI gating — installs Chromium, runs both lanes + uploads the run artifacts (nightly + dispatch + on benchmark changes) |

The executor is engine-agnostic by construction: the runner's `makeExecutor`
seam swaps `createWorkspaceBenchmarkExecutor` (jsdom-web) for
`createChromiumBenchmarkExecutor` (chromium) with no change to the tasks,
adapter, policies, reward, or report shape.

## Results (committed artifacts)

Both produced by a real Chromium process on this machine
(`Google Chrome for Testing`, installed via `bunx playwright install chromium`):

**MiniWoB++ engine-parity lane** (same suite, real Chromium instead of JSDOM):

| Artifact | engine | policy | solved |
|----------|--------|--------|--------|
| `miniwob-chromium-oracle-run.json` | chromium | oracle | **18 / 18** (100%) |
| `miniwob-chromium-noop-run.json`   | chromium | noop   | **0 / 12** |

The oracle solving every task and the noop baseline solving none — on a real
browser — is the engine-parity proof: identical tasks + identical oracle
sequences + identical reward, two real engines.

**Web-element grounding lane** (ScreenSpot-Web-style point-in-bbox through the
real screenshot + click path — `src/benchmark/grounding.ts`):

| Artifact | grounder | in-box | real clicks reaching target |
|----------|----------|--------|------------------------------|
| `web-grounding-chromium-oracle-run.json` | oracle (bbox centre) | **5 / 5** (100%) | **5 / 5** (100%) |
| `web-grounding-chromium-corner-run.json` | corner (0,0)         | **0 / 5**         | **0 / 5** |

Each sample's bbox is read from the live render via a real `get box` command,
the screenshot is real PNG bytes from the browser, and the click is a real
coordinate `mouse` click whose navigation is verified to reach the target — the
oracle grounder grounds + clicks every target, the corner baseline none.

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

**Mind2Web replay lane** (the external-dataset lane — `src/benchmark/mind2web.ts`):

| Artifact | engine | source | tasks solved | step accuracy |
|----------|--------|--------|--------------|---------------|
| `mind2web-chromium-run.json` | chromium | fixture | **1 / 1** | **3 / 3** (100%) |

`packages/benchmarks/mind2web/eliza_agent.py` scored Mind2Web through the
inference layer and never executed the action through plugin-browser. This lane
replays a Mind2Web-format `CLICK → TYPE → SELECT` sequence (the schema in that
package's `dataset.py`) through the REAL BROWSER command surface — each step's
own cached snapshot is `network route`d, the operation runs through a real
BROWSER command, and the effect is verified via a real `get` read. The embedded
fixture runs by default; the full `osunlp/Mind2Web` corpus drives the lane when
`MIND2WEB_DATA_DIR` points at a converted task set (`loadMind2WebTasks`).

## All four #10333 items landed

| #10333 checklist item | status |
|-----------------------|--------|
| Real-Chromium engine lane | ✅ MiniWoB++ on real Chromium |
| External-dataset benchmark (Mind2Web) through plugin-browser | ✅ Mind2Web replay (CLICK/TYPE/SELECT) — fixture + gated `MIND2WEB_DATA_DIR` corpus |
| Web-element grounding benchmark | ✅ ScreenSpot-Web-style point-in-bbox + real click path |
| Gate the heavy lanes in CI | ✅ `browser-real-bench.yml` |

The full external corpora (the multi-GB HF `osunlp/Mind2Web` cached HTML, a
dockerized WebArena) stay gated behind `MIND2WEB_DATA_DIR` / their own
environments — the lanes self-skip / run the embedded fixtures without them, so
the un-gated path is a self-contained, reproducible check while the corpus run
lights up wherever the data is mounted. Every lane drives the same
`BrowserCommandExecutor` seam.

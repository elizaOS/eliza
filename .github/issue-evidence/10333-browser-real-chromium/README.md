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
| `vitest.real.config.ts` | Dedicated config that opts the `*.real.test.ts` lanes back in (the root config excludes them); runs them sequentially (one browser at a time) |
| `scripts/run-miniwob-chromium-benchmark.mjs` / `run-web-grounding-benchmark.mjs` | Artifact runners (`bench:miniwob:chromium`, `bench:grounding:chromium`) |
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

## Still deferred (tracked on #10333)

- **External-dataset benchmark (Mind2Web / WebArena)** through real
  plugin-browser BROWSER actions. This is the one remaining lane that needs a
  multi-GB external dataset (Mind2Web's cached step HTML) or a dockerized site
  environment (WebArena), so the full run stays genuinely CI-infra-gated. It
  extends through the same `BrowserCommandExecutor` seam these two lanes already
  exercise.

This PR lands the **real-Chromium engine lane**, the **web-element grounding
lane**, and the CI gate — two of #10333's three deferred items.

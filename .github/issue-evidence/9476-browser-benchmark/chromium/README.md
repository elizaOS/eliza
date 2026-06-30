# #10333 / #9476 — MiniWoB++ benchmark through a REAL Chromium engine

The original #9476 benchmark drives the MiniWoB++ suite through plugin-browser's
JSDOM web-mode router. This closes the deferred **"real-engine lane"** (#10333):
the **same** task suite + adapter + oracle, driven against a **real Chromium
engine** (Microsoft Edge via puppeteer-core).

The adapter is engine-agnostic (`BrowserCommandExecutor`), so no task/adapter/
runner code changed — only a new executor (`src/benchmark/chromium-executor.ts`)
that maps each BROWSER command to a puppeteer page action and serves the routed
task HTML via puppeteer **request interception** (the real-browser analog of the
web-mode `network route` interceptor — no external network, deterministic).

## Result (real Edge, Windows 11 host)

`miniwob-chromium-run.json` — **18/18 solved (100%)**, `engine: "chromium"`,
oracle policy, 3 seeds × 6 tasks. The `*.real.test.ts` lane also asserts every
executed step ran with `commandResult.mode === "chromium"` and that a noop policy
scores 0 (reward discriminates on the real engine too).

## Screenshots (captured from the real browser)

| File | Shows |
|------|-------|
| `task-click-button.png` | After the oracle clicked the labelled button → the routed **WOB SUCCESS** page (`episode reward = 1`). |
| `task-click-link.png` | Same, via the correct hyperlink. |
| `task-enter-text.png` | The field containing exactly the requested token (`Enter "Tobias" …` → `Tobias`) typed by puppeteer. |
| `task-enter-text-dynamic.png` | The per-seed dynamic token typed in. |
| `task-click-checkboxes.png` | The target checkboxes checked. |
| `task-multistep-purchase.png` | After the home → catalog → buy navigation → WOB SUCCESS. |

## Run it

```bash
# gated real lane (needs a Chromium binary; auto-detected or PUPPETEER_EXECUTABLE_PATH):
bun run --cwd plugins/plugin-browser bench:miniwob-chromium
# the *.real.test.ts lane (excluded from default `vitest run`):
bunx vitest run plugins/plugin-browser/src/benchmark/__tests__/miniwob-chromium.real.test.ts \
  --config packages/test/vitest/real.config.ts
```

Remaining #10333 items (external-dataset benchmark — Mind2Web/WebArena — through
plugin-browser, web-element grounding benchmark, CI gating of the heavy lanes)
are still open; this delivers the real-Chromium engine lane.

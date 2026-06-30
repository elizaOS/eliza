# #10333 — real-Chromium engine lane for the plugin-browser benchmark

Evidence that the MiniWoB++ benchmark suite now runs end-to-end through a **real
Chromium** (not JSDOM web mode), via the same engine-agnostic
`BrowserBenchmarkAdapter` seam — the first "Needs CI infra" item from #9476's
deferred checklist (tracked in #10333).

## What this is

- **New executor:** `plugins/plugin-browser/src/benchmark/chromium-executor.ts`
  — a `BrowserCommandExecutor` (`engine: "chromium"`) that drives the same
  `BrowserWorkspaceCommand`s (`navigate`/`click`/`type`/`check`/`get`/…) against a
  real Chromium-family browser through **puppeteer-core** (already a
  plugin-browser dependency; no Chromium bundled). Each episode renders the
  task's routed HTML through request interception — no external network, exactly
  like the JSDOM lane's `network route`.
- **New gated lane:** `src/benchmark/__tests__/miniwob-chromium.real.test.ts` —
  excluded from the default unit config, run via `packages/test/vitest/real.config.ts`
  (mirrors the computeruse `*.real.test.ts` lanes). Self-skips when no
  Chromium-family browser is resolvable; CI provisions one with
  `bunx playwright install chromium`.
- The lane asserts **both directions** on the real engine: the **oracle solves
  every task** (reward 1, every step an `engine: "chromium"` command), and the
  **noop baseline fails** (reward 0) — so the reward is grounded in real rendered
  DOM state, not hard-coded.

## Artifacts here

- `scorecard.json` — the oracle run on a real browser: **6/6 tasks solved**,
  per-task trajectory (each action + its real-command `resultMode`).
- `<NN>-<task>-start.png` / `<NN>-<task>-solved.png` — real Chromium screenshots
  of each task's start page and its post-oracle (solved) state. E.g.
  `05-click-checkboxes-solved.png` shows the agent having checked exactly the
  requested checkbox ("lemon") and left the rest unchecked — the reward criterion,
  visually confirmed in a real browser.

## Reproduce

```bash
# the gated assertion lane (oracle solves all / noop fails on real Chromium)
bun run --cwd plugins/plugin-browser test:real:chromium
# the screenshot + scorecard evidence
bun run --cwd plugins/plugin-browser bench:miniwob:chromium
```

Captured on a Windows 11 host against the Playwright-installed Chromium
(`ms-playwright/chromium-1228/chrome-win64/chrome.exe`) — the same browser CI
provisions with `bunx playwright install chromium`. The resolver also falls back
to a system Chrome/Edge/Brave when no Playwright Chromium is present (both are
real Chromium-family engines; `scorecard.json` records the exact executable
used).

## Remaining #10333 items (still deferred)

External-dataset benchmark (Mind2Web/WebArena) through plugin-browser, a
web-element grounding benchmark, and gating the heavy lanes in CI — these need
larger external datasets / CI runner work and remain tracked on #10333.

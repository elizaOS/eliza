# Evidence — full-journey walkthrough generator (#10198 / #10204)

Builds the missing `full-walkthrough.spec.ts` JOURNEY.md promised: one continuous,
analyzed, recorded narrative across web + the native device matrix. A reviewer can
confirm it works from the artifacts below **without reading the code**.

## How to reproduce (one command)

```bash
bun run --cwd packages/app test:e2e:walkthrough          # keyless mock lane (this evidence)
bun run --cwd packages/app test:e2e:walkthrough:live     # real backend + model lane
bun run --cwd packages/app test:e2e:walkthrough:ios      # iOS sim leg + capture
bun run --cwd packages/app test:e2e:walkthrough:android  # Android emu/device leg
```

## Mock lane (keyless, PR-safe) — GREEN, both viewports

The 25-step journey (cold launch → onboarding → tutorial → help → settings →
wallet → chat → character → view-switch → settings-edit → dashboard) drove the
**real** app surface at desktop (1440×1000) and mobile (390×844).

- **desktop: 25/25 steps passed**, gate `ok: true` — 0 page/console errors, 0 5xx.
- **mobile: 25/25 steps passed**, gate `ok: true`.
- Run: `reports/walkthrough/2026-06-29_20-20-57_mock` (gitignored); per-step
  `NN-<step>.png` + `NN-<step>.json` manifest (URL, viewport, DOM markers,
  per-step diagnostics, passed assertions) + `logs/{console,network}.log`.
- Collated logs: `10198-full-walkthrough-logs.txt` (gate + clean console + the
  real `/api/*` requests the journey fired).
- Per-step manifest sample: `10198-full-walkthrough-steps-desktop.json`.

## Human-speed recordings (one film per viewport)

One stitched film per viewport, 25 frames × 2.6s = **65s**, paced for a human to
follow (this host's ffmpeg lacks the `drawtext` filter, so frames are paced but
uncaptioned — documented in the entrypoint):

- `10198-full-walkthrough-desktop.mp4` (1.25 MB, 65s)
- `10198-full-walkthrough-mobile.mp4` (783 KB, 65s)
- Contact sheets: `10198-full-walkthrough-contact-desktop.png` /
  `…-contact-mobile.png`.

## Per-step vision verdicts

`scripts/ai-qa/review-walkthrough.mjs` (binds the existing AI-QA `review-lib.mjs`
to the ordered steps) → committed `packages/app/test/ui-smoke/walkthrough/WALKTHROUGH_VERDICTS.md`.

- The automated reviewer is **wired and functional** — it made 50 real
  `api.anthropic.com` vision calls — but every call returned HTTP 400 *"Your
  credit balance is too low"*: the host's `ANTHROPIC_API_KEY` is **unfunded**.
- So the 50 captures were **hand-reviewed** (8 vision-capable agents, batched)
  against each step's `JOURNEY.md` expectation. Result: **45 good · 5 needs-work
  · 0 broken** — the gate passes (0 broken). Full table:
  `packages/app/test/ui-smoke/walkthrough/WALKTHROUGH_VERDICTS.md`.
- The two `needs-work` findings are **pre-existing app defects the walkthrough
  correctly surfaced** (out of scope to fix per the issue — it drives/records the
  existing surfaces, it does not change them):
  - **character editor** leaks i18n placeholder keys in the Style Rules section
    ("Style Rules Header", "Style Rules Help", "Post Examples Help", "Add Style
    Rule Short").
  - **settings** floating back-arrow button overlaps the "Settings" sidebar
    title, clipping its leading "S".

## iOS simulator (Mac/iOS host) — captured

The real Eliza app, home/dashboard surface, on the booted iPhone 16 Pro simulator
(native Dynamic Island visible) — same UI as the web walkthrough's home state:

- `10198-walkthrough-ios-sim-ios-sim.png` (real app on the sim; 10s `.mov`
  captured locally, omitted from git for size).
- `10198-full-walkthrough-device-matrix.json`: `ios-simulator: captured`,
  `android-emulator: n/a`.
- WKWebView has **no CDP/remote DOM driver**, so the full DOM-driven journey
  cannot run identically on iOS; the iOS journey is driven in-app via the
  Capacitor UserDefaults handshake. This asymmetry is documented in
  `packages/app/test/ui-smoke/walkthrough/DEVICE_MATRIX.md`.

## Live real-model lane — wired; trajectory N/A on this host (concrete reason)

`test:e2e:walkthrough:live` boots the **real backend agent** (`ELIZA_UI_SMOKE_LIVE_STACK=1`,
`packages/app-core/src/runtime/eliza.ts`); in that lane the chat step installs no
conversation mock, so it drives the real model. A real-model trajectory could
**not** be captured on this host:

- `ANTHROPIC_API_KEY`: unfunded (HTTP 400 "credit balance too low" — same proof
  as the vision review).
- `OPENAI_API_KEY`: rejected as invalid by the OpenAI API.
- Ollama (installed as a credit-free fallback, with `eliza-1` + `llama3.2:1b`
  models present): the chat-completions endpoint hangs (>120s, no reply) on this
  contended host, so the `local-llama-cpp` provider path could not produce a
  reply either.

The keyless PR lane is therefore **labeled mock** (per the acceptance criteria),
and the live lane is wired + runnable for any host with a funded provider key or a
responsive local model server.

## Android — N/A (no device on this Mac host)

`adb devices` is empty. The Android lane is wired (`android-e2e.mjs` real-WebView
CDP journey + `capture-android-emu.mjs`); run it on a Linux/Android host or with a
device attached. Recorded in `device-matrix.json`.

## Files (the build)

- `packages/app/test/ui-smoke/full-walkthrough.spec.ts` — the spec (NEW)
- `packages/app/test/ui-smoke/walkthrough/journey.ts` — step model + route
  installers + recorder (NEW)
- `packages/app/test/ui-smoke/walkthrough/JOURNEY.md` — extended 25-row assertion
  table + current selectors (the old `onboarding-toast` / home-tile selectors were
  stale; the current in-chat first-run uses `first-run-chat` + `choice-*`)
- `packages/app/test/ui-smoke/walkthrough/WALKTHROUGH_VERDICTS.md` (NEW)
- `packages/app/test/ui-smoke/walkthrough/DEVICE_MATRIX.md` (NEW)
- `packages/app/scripts/walkthrough-e2e.mjs` — one-command entrypoint (NEW)
- `packages/app/scripts/walkthrough-device-matrix.mjs` — device-matrix runner (NEW)
- `scripts/ai-qa/review-walkthrough.mjs` — vision-review adapter (NEW)
- `packages/app/package.json` — `test:e2e:walkthrough[:live|:ios|:android|:device]`

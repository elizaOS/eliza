# @elizaos/app-model-tester

Developer tool that exposes end-to-end probes for every Eliza model type through HTTP routes and a React UI applet.

## Purpose / role

Adds a Model Tester surface to an Eliza agent's dashboard. It registers three HTTP routes and a single GUI view so developers can run live probes against text, embedding, speech synthesis, transcription, voice-activity-detection, image description, and image generation models — all from a browser. Load it by adding `modelTesterPlugin` to the agent's plugin list; it is opt-in (not default-enabled).

## Plugin surface

Registered in `src/plugin.ts` as `modelTesterPlugin`:

**Routes**
- `GET /model-tester` — serves a self-contained static HTML tester shell (no build step required to use).
- `GET /api/model-tester/status` — returns JSON array of all probe types with `available` flag and registered provider names drawn from the runtime's model registry.
- `POST /api/model-tester/run` — runs one probe by `test` kind; accepts optional `prompt`, `imageDataUrl`, `audioDataUrl`, `pcmSamples`, and `sampleRateHz` in the JSON body.

**Views** (registered via elizaOS view registry)
- `model-tester` — `ModelTesterView` React component, path `/model-tester`, `modalities: ["gui"]`, with capabilities `get-status`, `run-text-small`, `run-transcription`, `run-vision`, `run-vad`. Shipping is GUI-only; `"tui"`/`"xr"` remain valid modality values for compatibility but this plugin no longer declares them.

**Overlay app + shell page** (registered at module load in `src/model-tester-app.ts`)
- `registerOverlayApp` — adds the plugin to the overlay app registry under `@elizaos/app-model-tester`.
- `registerAppShellPage` — mounts `ModelTesterShellPage` at `/model-tester` and `ModelTesterTuiView` at `/model-tester/tui`.

No actions, providers, services, or evaluators are registered.

## Probe types

| `test` value | `ModelType` constant | Notes |
|---|---|---|
| `text-small` | `TEXT_SMALL` | Tries providers: default → `eliza-local-inference` → `anthropic` → `openai` |
| `text-large` | `TEXT_LARGE` | Streaming; tries default → `eliza-local-inference` |
| `embedding` | `TEXT_EMBEDDING` | Returns vector dimensions and an 8-element preview |
| `image` | `IMAGE` | Tries local SD 1.5 first, then default/openai |
| `image-description` | `IMAGE_DESCRIPTION` | Tries local inference first, then default/anthropic/openai |
| `transcription` | `TRANSCRIPTION` | Falls through: local inference → elizacloud → openai |
| `text-to-speech` | `TEXT_TO_SPEECH` | Falls through: local inference → openai → default |
| `vad` | n/a (pure JS) | RMS-based voice-activity detection; always available |

Local inference probes call `@elizaos/plugin-local-inference/services` directly via dynamic import and activate the first installed `eliza-1-*` bundle if none is active.

## Layout

```
src/
  index.ts                      — package entry; re-exports plugin + app + routes + view
  plugin.ts                     — defines modelTesterPlugin (Plugin object): routes + views
  routes.ts                     — handleModelTesterRoute() + all probe logic + static HTML shell
  model-tester-app.ts           — registerOverlayApp + registerAppShellPage (runs at import)
  ModelTesterAppView.tsx        — React UI: ModelTesterAppView, ModelTesterTuiView
  ModelTesterAppView.interact.ts — interact() TUI capability handler (split out for Fast Refresh compatibility)
  model-tester-view-bundle.ts   — Vite view-bundle entry: re-exports components + interact for dist/views/bundle.js
  components/
    ModelTesterSpatialView.tsx  — spatial presentational view (GUI-shipped)
  ui.ts                         — thin re-export of ModelTesterAppView + modelTesterApp for consumers
scripts/
  model-tester-e2e.mjs          — Node e2e harness (used by test:e2e)
```

## Commands

```bash
bun run --cwd plugins/app-model-tester build       # tsup + tsc type declarations
bun run --cwd plugins/app-model-tester clean       # rm -rf dist
bun run --cwd plugins/app-model-tester test:e2e    # end-to-end probe runner (needs live server)
```

## Config / env vars

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MODEL_TESTER_BASE_URL` | No | `http://127.0.0.1:31337` | Base URL for the e2e script |
| `MODEL_TESTER_REQUIRE_ALL` | No | `"0"` | Set `"1"` to make the e2e script fail if the server is unreachable |
| `ELIZA_MTP_ALLOW_ZERO_DRAFT` | No | — | Set to `"1"` by the run handler before calling text probes (allows MTP with zero draft tokens) |

No plugin-specific env vars are read at load time. Model provider credentials (Anthropic, OpenAI, etc.) are resolved by the elizaOS runtime through the normal model registry; configure those at the agent level.

## How to extend

**Add a new probe kind:**
1. Add the new literal to the `TestKind` union in `src/routes.ts` and to the `TestId` union in `src/ModelTesterAppView.tsx`.
2. Add a `MODEL_TESTS` entry in `src/routes.ts` with the matching `ModelType` constant.
3. Add a `case` branch in `runModelTest()` (`src/routes.ts`) that calls `runtime.useModel(...)` and returns a plain serialisable object.
4. Add a `TEST_COPY` entry in `src/ModelTesterAppView.tsx` for the UI label/subtitle.
5. If the probe should be reachable from the TUI, add its `capability` to the `views` entry in `plugin.ts` and handle it in `interact()` and `MODEL_TESTER_COMMAND_TO_TEST` in `src/ModelTesterAppView.interact.ts`.

**Add a new route:**
1. Define a `Route` object in `plugin.ts` and push it into `modelTesterRoutes`.
2. Add the matching branch to `handleModelTesterRoute()` in `src/routes.ts`.

## Conventions / gotchas

- **Provider fallthrough pattern:** every probe tries `eliza-local-inference` first (direct FFI via `@elizaos/plugin-local-inference/services`), then cloud providers. Failures are collected in an `attempts` array and surfaced in the JSON response, not thrown immediately.
- **Local inference activation:** `ensureLocalEngineActive()` in `routes.ts` is a singleton: it reuses an in-flight `localActivationPromise` so concurrent probes don't race to load the model.
- **Static HTML shell:** `GET /model-tester` serves a complete standalone HTML page inlined in `routes.ts`. It has no Vite/HMR dependencies; the e2e script asserts there are no `@vite/client` references in the response.
- **VAD is always available:** the `vad` probe is pure JavaScript (RMS framing in `detectVoiceActivity()`); it has no `ModelType` and is marked `available: true` in the status response unconditionally.
- **Audio defaults:** when no audio is uploaded the transcription probe synthesises speech from the prompt using local TTS and feeds that back as the transcription input (`source: "local-tts-loopback"`). The VAD probe falls back to a 1-second 440 Hz sine tone at 16 kHz.
- **Module-side-effect registration:** importing `src/model-tester-app.ts` (or the package root) calls `registerOverlayApp` and `registerAppShellPage` immediately. This is intentional; do not tree-shake these imports.
- **interact() split:** `interact()` lives in `src/ModelTesterAppView.interact.ts`, not `ModelTesterAppView.tsx`, so the component file exports only React components and remains Fast Refresh-compatible. The view bundle re-exports it via `model-tester-view-bundle.ts`.
- **Spatial view:** `components/ModelTesterSpatialView.tsx` is a presentational component (pure snapshot + callback in, spatial primitives out) shipped for the GUI modality only.
- See the root `AGENTS.md` for repo-wide conventions (logger-only, ESM, architecture rules, naming).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — UI surface:**
- Before/after **full-page** screenshots — desktop **and** mobile, portrait **and** landscape, rest **and** hover (`bun run --cwd packages/app audit:app` where applicable) — not desktop-only-happy-path (see #9950).
- A **video walkthrough** of the whole view/flow, plus browser console + network logs showing the real request/response and state change.
- Empty, loading, error, and permission-denied states — and fill the per-view manual-review verdict (`good`/`needs-work`/`needs-eyeball`/`broken`); no page ships `needs-work`/`broken`.
- The backend trajectory/logs behind anything the UI triggered.
<!-- END: evidence-and-e2e-mandate -->

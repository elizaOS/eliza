# App E2E live coverage — what is real vs stub, and how to make it real

This is the standing answer to "do the `packages/app` e2e tests actually test
onboarding, cloud login, cloud/local provisioning, and chat — for real, not
against a mock?" Read this before adding or trusting an app e2e lane.

## Desktop (Electrobun) packaged e2e — now Linux-capable

The packaged-desktop suite (`playwright.electrobun.packaged.config.ts`,
`test/electrobun-packaged/*.e2e.spec.ts`) was darwin/win32-only. It is now
Linux-capable:

- The eliza desktop app **builds on Linux** —
  `node packages/app-core/scripts/desktop-build.mjs build` (run from the eliza
  repo root so `ROOT=cwd` resolves `packages/app`, not a wrapper repo's
  `apps/app`). Output: `packages/app/electrobun/build/dev-linux-x64/Eliza-dev/`
  with `bin/launcher`.
- The app **launches and boots its embedded agent on Linux** (GTK shell, static
  server, PGLite migrations, plugin registry) — verified by running `bin/launcher`.
- The packaged-test harness is Linux-aware: `packaged-app-helpers.ts` now detects
  the Linux `bin/launcher`, sets a Linux env (DISPLAY + software GL), and the
  suite guard (`isPackagedPlatform`) allows linux. Script: `test:desktop:packaged`
  (`bunx playwright test --config playwright.electrobun.packaged.config.ts`).
- **A real packaged-app bug was found and fixed by this:** three JSON imports
  (`plugin-wallet/.../gov-router.ts`, `plugin-mysticism/.../tarot/{spreads,deck}.ts`)
  lacked the `with { type: "json" }` import attribute that bun's packaged runtime
  requires, breaking the wallet plugin's API on boot. Fixed to match the repo
  convention.

**Known limitation (headless):** the renderer-driving packaged tests (state
persistence, reset, relaunch UI) need a real GPU display — the app uses WebGPU
(`libwebgpu_dawn.so`). On a bare headless box, `DISPLAY=:0` (no GPU) renders the
webview blank (`GLXBadWindow`, "no renderer result"), and `xvfb` software GL makes
the app exit on WebGPU init. Run the packaged renderer tests on a GPU-capable
runner (or a desktop with a display); the build, launch, agent-boot, and harness
integration all work headlessly. The desktop-only *renderer surfaces*
(detailed onboarding, desktop controls) are also covered keyless via the ui-smoke
harness with `__electrobunWindowId` injection (see below).

## TL;DR

The PR-gating lanes (`scenario-pr.yml`, `ci.yaml`, `test.yml`) run the entire
`test/ui-smoke` suite against a **deterministic stub**, never a real backend.
Two locks force this:

- `packages/app-core/scripts/playwright-ui-live-stack.ts` selects the stub when
  `shouldForceStubStack(env)` is true — i.e. `ELIZA_UI_SMOKE_FORCE_STUB=1` **or**
  (`CI=true` **and not** `ELIZA_UI_SMOKE_LIVE_STACK=1`). GitHub Actions always
  sets `CI=true`.
- `packages/app/scripts/run-ui-playwright.mjs` also sets
  `ELIZA_UI_SMOKE_FORCE_STUB=1` unless `ELIZA_UI_SMOKE_LIVE_STACK=1`.

Specs that *name* the cloud dimensions (`cloud-provisioning-startup`,
`auth-startup`) add a **second** layer of `page.route()` canned JSON on top of
the stub. They are good UI-contract tests, but they assert the UI against the
test's own fixtures — not against Eliza Cloud.

So, in the gating lanes:

| Dimension | Gating-lane reality |
|---|---|
| Onboarding (cloud branch) | Real UI driven, stubbed responses — completion asserted (`cloud-provisioning-startup.spec.ts`) |
| Onboarding (local/remote branch) | **Not reachable** — keyless web is cloud-only; the compact `CompactOnboarding`/`StartupScreen` shows only the Cloud "Connect". Local/remote cards live in the detailed `FirstRunScreen`, a desktop-shell surface. |
| Cloud login | In the **app** keyless lane: larp (`page.route` canned token; the stub has no `/api/cloud/login`). The **real** cloud auth contract is tested for real in `packages/test/cloud-e2e/tests/auth-errors.spec.ts` against a real cloud-api (see "Real cloud" below). |
| Cloud provisioning | In the **app** keyless lane: `page.route` canned job, now driving a real `pending→in_progress→completed` transition. The **real, not-larp** provisioning lifecycle is tested in `packages/test/cloud-e2e/tests/provision.spec.ts` against a real cloud-api (see "Real cloud" below). |
| Local provisioning (desktop) | **REAL, executed, gates every PR** — `check-real-local-provisioning.ts` boots an actual `AgentRuntime` on PGLite + the real app-core API and asserts it provisions and serves (no model/secret/stub). Wired into `scenario-pr.yml` as `app-core test:local-provisioning`. |
| Local provisioning (android) | Real on-device GGUF smoke exists (`scripts/mobile-local-chat-smoke.mjs`) but runs in **no** workflow |
| Local provisioning (web) | **Not a product capability** — web is cloud-only (`canRunLocal()` is false on prod web, `shared/src/config/cloud-only.ts`) |
| Chat (local) | **REAL pipeline, executed, gates every PR** — `check-real-local-chat.ts` runs a real runtime + real conversation routes + real message handling + real history with a deterministic in-process model (no key/llama). Plus real-model turns in `dev-smoke.yml` + `app-live-e2e.yml`. |
| Chat (cloud) | No real cloud-chat turn exists anywhere; "cloud chat" in `cloud-provisioning-startup.spec.ts` asserts the **local** stub fixture |

## Real local provisioning in the keyless lane (no secret needed)

Local agent provisioning does **not** need a model or secret — `withLLM:false`
skips the llama-backed embedding plugin, so a real `AgentRuntime` boots on a real
PGLite database in ~2.5s. `packages/app-core/scripts/check-real-local-provisioning.ts`
(`bun run --cwd packages/app-core test:local-provisioning`) boots that runtime +
the real `startApiServer`, then asserts `/api/health` is `ready` with a real DB
and loaded plugins, `/api/status` reports the running agent, and `POST /api/first-run`
flips first-run to complete. It is wired into `scenario-pr.yml`, so **every PR is
gated on genuinely-real (not fixtured) local provisioning** — the one real-backend
dimension that needs no external prerequisite. Run it via the repo's tsx runner,
not vitest (vitest's aliasing stubs out plugin handlers like edge-tts and breaks
`runtime.start`).

## Real local chat in the keyless lane (deterministic model, real pipeline)

Local chat does not need a provider key or llama either: registering the
deterministic LLM proxy (`packages/test/mocks/helpers/llm-proxy-plugin.ts` — a
real `Plugin` with real handlers for every text model + embedding +
`RESPONSE_HANDLER` + `ACTION_PLANNER`, priority 1000) on a real runtime gives a
fully chat-capable agent with deterministic output.
`packages/app-core/scripts/check-real-local-chat.ts`
(`bun run --cwd packages/app-core test:local-chat`) boots that runtime + the real
API, creates a real conversation, posts a user message, and asserts the agent
replies through the **real message pipeline** and that both messages persist in
real history. This is fundamentally different from the ui-smoke api-stub, which
fakes the whole `/api/conversations/*` endpoint and never touches the runtime —
here the conversation routes, message handling, response decision, and
persistence are all real; only token generation is deterministic. Wired into
`scenario-pr.yml`, so **every PR is gated on a genuinely-real local chat turn**.

## Real voice pipeline — STT and TTS, fully local, no mocks

The voice stages are validated with real engines + real models, not the
silent-WAV / shimmed-transcript stubs the keyless ui-smoke lane uses:

- **Real STT** — `plugins/plugin-local-inference/src/services/voice/whisper-cpp-asr.real.test.ts`
  transcribes a real speech WAV through the actual whisper.cpp FFI adapter + a
  real ggml model (`bun test`, GPU). Build `native/build-whisper.mjs`.
- **Real TTS → STT round-trip (gold standard)** —
  `.../voice/voice-roundtrip.real.test.ts`: text → real **OmniVoice** TTS
  (`omnivoice-tts` CLI + OmniVoice base/tokenizer GGUF) → real 24 kHz speech WAV
  → assert non-silent real signal → ffmpeg resample → real whisper STT → assert
  the transcript reads back the spoken words. Subprocess-based, runs under
  vitest; self-skips unless the built CLIs + GGUFs + whisper model + ffmpeg
  resolve. `bun run --cwd plugins/plugin-local-inference test:voice:roundtrip`.
  Validated on GPU: *"And so my fellow Americans, ask not what your country can
  do for you."* synthesizes and transcribes back verbatim.

Build steps: `node plugins/plugin-local-inference/native/build-omnivoice.mjs`
(+ `cmake --build native/omnivoice.cpp/build --target omnivoice-tts`) and
`node .../native/build-whisper.mjs`; stage the OmniVoice GGUFs from HF
`elizaos/eliza-1` (`voice/omnivoice/omnivoice-base-q4_k_m.gguf` +
`omnivoice-tokenizer-q4_k_m.gguf`) under
`<stateDir>/local-inference/models/omnivoice/` and a whisper ggml model under
`~/.cache/eliza-whisper-models/`. The Kokoro GGUF path is `missing-from-local-staging`
in the HF repo (`voice-models.ts`); OmniVoice is the available local TTS engine.

## Real LLM through the *shipped UI*, fully local + keyless (Ollama recipe)

The dev-smoke lane (`playwright.dev-smoke.config.ts` → `bun run dev` = real API +
real vite renderer, no 12-min dist build) drives the **real shipped renderer**
against a **real agent**. `bun-dev-onboarding-chat.spec.ts` completes onboarding
and sends a chat turn; `selectLiveProvider()` picks the provider from env. With no
provider key it self-skips — but it can run truly-real and keyless against a local
model served by **Ollama's OpenAI-compatible endpoint**, no paid key:

```bash
ollama serve &                     # then: ollama create eliza-1-0_8b -f Modelfile  (FROM <gguf>)
OPENAI_API_KEY=local \
OPENAI_BASE_URL=http://localhost:11434/v1 \
ELIZA_LIVE_TEST_SMALL_MODEL=llama3.2:3b ELIZA_LIVE_TEST_LARGE_MODEL=llama3.2:3b \
OPENAI_SMALL_MODEL=llama3.2:3b OPENAI_LARGE_MODEL=llama3.2:3b \
  bun run --cwd packages/app test:dev-smoke test/dev-smoke/bun-dev-onboarding-chat.spec.ts
```

`selectLiveProvider()` registers `@elizaos/plugin-openai` pointed at Ollama, so
the agent's TEXT_SMALL/TEXT_LARGE are a **real local model**. Verified green on an
RTX-class GPU (warm inference ~0.1s/10tok). Use a capable instruct model
(`llama3.2:3b`) — the 0.8B Eliza-1 reasoning model does not reliably follow
"reply with exactly X" through the full agent pipeline.

**Two non-obvious hazards this lane surfaced (both fixed in the harness):**

1. **Prompt-echo false green.** Asserting a marker against the whole conversation
   log passes even when the agent never replies, because the user's prompt
   ("reply with exactly <MARKER>") contains the marker. The spec now asserts the
   marker on a `data-role="assistant"` thread line
   (`[data-testid="thread-line"][data-role="assistant"]`). This was a real larp.

2. **Deferred-provider timing race.** Model-provider plugins register in the
   deferred boot phase, *after* `/api/health` flips `ready`. A chat fired
   immediately can race that registration; with first-run target `local`, the
   prefer-local router then picks `plugin-local-inference` (priority −100,
   registered at pre-init in `core-plugins.ts`) which throws
   `LocalInferenceUnavailableError` when no in-process engine/model is active, and
   the fall-through to plugin-openai only happens once openai is a registered
   candidate. `warmUpModel()` (live-onboarding.ts) resends a probe until a real
   reply lands, eliminating the flake. (`ELIZA_SKIP_PLUGINS` does **not** remove
   local-inference here because its text handler is wired at pre-init, not via the
   plugin list.)

### Open: chat-driven view switching via a real LLM (UI e2e)

The product path is: chat → the agent selects the `app-control` VIEWS "show"
action → `POST /api/views/:id/navigate` → server broadcasts `shell:navigate:view`
→ client re-dispatches `eliza:navigate:view` → `App.tsx` routes. The **server
broadcast half is unit-tested** (`packages/agent/src/api/views-routes.navigate-broadcast.test.ts`)
and the **client DOM-event → shell hop is covered** (ui-smoke
`task-widget-in-chat.spec.ts`). The missing piece is a real-LLM e2e where the
model *chooses* to navigate from a chat message. A dev-smoke spec capturing
`eliza:navigate:view` was prototyped but a local `llama3.2:3b` did not reliably
select the navigate action from a free-form "open the wallet view" prompt.
`plugin-app-control` IS a core plugin and its actions load fine in dev — the
`views-registry` "could not resolve package directory" warning is scoped to the
view *bundle* (rendering), not the actions — so this is purely a model
action-selection/affinity gap, not a loading bug. Next step: validate against a
capable action-selecting model (claude-haiku / gpt-5-mini) in the nightly
`app-live-e2e.yml` lane, optionally biasing selection via view-action affinity.

## Keyless interaction depth (buttons/flows)

The keyless lane is stub-backed, but that does not mean "render-only." Built-in
diagnostic page-views (logs, memories) used to be load-smoked by
`all-pages-clicksafe` and nothing else — their controls were never clicked.
`apps-diagnostics-interactions.spec.ts` (wired into `scenario-pr.yml`) now drives
those controls and asserts they *do something*: the logs search really filters
entries and clear restores them; the logs refresh re-queries the source; the
memory viewer queries memory data on load and the Browse toggle switches the
surface and issues a browse query.

This was extended into broad, **enforced** interaction coverage:

- `apps-builtin-pages-interactions.spec.ts` — runtime (refresh re-queries),
  plugins (search filters), database (run a SQL query), skills (New Skill opens
  the create form), trajectories (search re-queries), relationships (graph
  loads), stream (offline surface), rolodex (views catalog).
- `settings-sections-interactions.spec.ts` — voice strategy select, appearance
  theme select, capability switch toggle, app-permission refresh, backup/export
  modal, character bio → Save (with the `/api/character` PUT mocked).
- `apps-personal-assistant-decomposed-interactions.spec.ts` — 7 of the 8
  decomposed PA views (calendar/inbox have real client controls; the rest assert
  the scaffold renders). These views are now registered in the ui-smoke stub
  (`smokeViewDeclarations`) so their bundles load. `documents` is excluded: its
  `/documents` view path collides with the built-in `documents` tab
  (`/character/documents`) via `App.tsx` `findView`, so it stays tracked debt
  (`MAX_INTERACTION_DEBT = 1`) until that path is disambiguated.
- `chat-viewmanager-companion-interactions.spec.ts` — view-catalog refresh,
  companion TUI controls.

**Enforcement:** `view-interaction-coverage.test.ts` now runs with
`INTERACTION_DEBT = {}` and `MAX_INTERACTION_DEBT = 0` — every view-matrix entry
must name an interaction-owner spec, so a new view without one fails CI. Combined
with `route-coverage.test.ts` (every route needs a clicksafe entry) and
`ui-smoke-coverage.test.ts` (every spec must be wired/classified), the three
ratchets make page/view coverage a non-regressing invariant.

### Control-level gaps with a real keyless blocker (the next layer)

These specific controls cannot be honestly tested in the keyless stub harness
without a product change or a heavy shim — documented here rather than covered by
a fragile/larp test:

Only two controls remain genuinely uncovered, both with proven blockers:

- **Chat message-action rail (copy/play/edit/delete)** — NOT a web feature: the
  rail lives only on the full `ChatView` transcript (`chat-transcript` →
  `chat-message`), but the web chat is the continuous-chat *overlay* (`thread-line`,
  no rail), **both** `AppWorkspaceChrome` mounts (`App.tsx:340,357`) pass
  `chatDisabled`, and the orchestrator renders no transcript — so the rail is never
  rendered anywhere in the web app. It is a desktop/full-ChatView surface, covered
  by component tests (`chat-message-actions.stories.tsx`,
  `chat-message.voice-speaker.test.tsx`) + the electrobun-packaged desktop lane. The
  web chat's OWN controls (fullscreen, attach) ARE covered by
  `chat-overlay-controls-interactions.spec.ts`.
- **Onboarding voice pill** — the voice-first flow gates on a Capacitor/browser
  mic-permission check + ASR-mode resolution + a spoken TTS prompt before listening;
  mic-permission + `SpeechRecognition` + media shims still don't flip
  `voice.listening` headless (two attempts failed honestly). Needs the real
  audio/mic path; voice readiness is unit-tested (`voice-readiness.test.ts`).
- **documents PA view** — `/documents` path collides with the `/character/documents`
  tab (see above); tracked as the single `INTERACTION_DEBT` entry.

**Closed this pass** (previously listed as gaps):
- Onboarding completion — `onboarding-completion-interactions.spec.ts` reaches the
  detailed `FirstRunShell` at `/onboarding` (first-run complete, bypassing
  `StartupScreen`) + host globals, and drives the **remote branch to a real
  `POST /api/first-run`**, the local-inference sub-choice, and the **web cloud-only**
  assertion (no local runtime offered on web).
- Vault modal — `vault-modal-interactions.spec.ts` + 4 stub-served load endpoints.
- Electrobun desktop controls — `desktop-workspace-interactions.spec.ts`.
- Chat overlay controls — `chat-overlay-controls-interactions.spec.ts` (fullscreen,
  attach).

## Real cloud — the cloud-api mock-stack (real backend, no external secret)

"Cloud provisioning real, not larp" is satisfied **repo-wide** by
`packages/test/cloud-e2e` (workflow `cloud-e2e.yml`, `bun run cloud:e2e`). Its
fixture (`src/fixtures/stack.ts`) boots, **in-process and with no Docker or cloud
secret**: a PGlite TCP bridge, an ioredis mock, a Hetzner (infra) mock, a
control-plane mock, and the **real cloud-api worker subprocess**. The tests then
exercise the real cloud-api orchestration:

- `tests/provision.spec.ts` — real provisioning job lifecycle (job transitions to
  running via a control-plane tick; full custom-image agent lifecycle + pairing).
- `tests/deprovision.spec.ts`, `suspend-resume.spec.ts`, `sleep-wake.spec.ts`,
  `scheduled-backup.spec.ts`, `stuck-cleanup.spec.ts` — the rest of the lifecycle.
- `tests/auth-errors.spec.ts` — the real cloud auth contract (401 on
  missing/invalid/malformed credentials, never 500).

Only the container *infrastructure* (Hetzner) is mocked — the provisioning logic,
job state machine, auth, billing, and pairing are the real cloud-api code. This is
the "real, not larp or mock" cloud coverage; the **app**-level cloud specs
(`cloud-provisioning-startup.spec.ts` keyless fixtures, `cloud-live.spec.ts`
gated) sit on top of it. (Note: this stack does not boot in every sandbox — the
cloud-api worker has known env sensitivities — but it runs in `cloud-e2e.yml` CI.)

## The keystone

`ELIZA_UI_SMOKE_LIVE_STACK=1` now overrides the `CI=true` stub force
(`shouldForceStubStack`, unit-tested in
`packages/app-core/scripts/lib/ui-smoke-stub-decision.test.mjs`). Before this, a
real lane was impossible in CI: `CI=true` re-forced the stub even with a
provider key present, so every `test.skip(!ELIZA_UI_SMOKE_LIVE_STACK)` block
self-skipped forever. This is the single seam every real lane drives through.

## Wired real lanes — `.github/workflows/app-live-e2e.yml`

Nightly + `workflow_dispatch`, never on PRs. All jobs share
`ELIZA_UI_SMOKE_LIVE_STACK=1` so the live stack boots the **real**
`@elizaos/app-core` runtime. Each job carries the secret it needs and skips
cleanly when that secret is absent (a failing real test is a signal, not larp).

| Job | Dimension | What it proves | Trigger |
|---|---|---|---|
| `app-live-chat` | chat (local) | real provider model turn from the UI, exact marker `APP_LIVE_AGENT_OK` (un-skips the live half of `live-agent-chat.spec.ts`) | nightly + dispatch |
| `cloud-live` | cloud login + provisioning + chat | `cloud-live.spec.ts`, **un-mocked**, drives real onboarding → real `agents → provision → jobs/{id}` → real `bridgeUrl` → a real (non-fixture) chat reply against real Eliza Cloud (`ELIZAOS_CLOUD_API_KEY` + `ELIZA_UI_SMOKE_CLOUD_LIVE=1`) | nightly + dispatch |
| `android-local-chat` | local provisioning (android) + chat | builds/installs the APK on an emulator, starts the native local runtime, asserts a real on-device GGUF reply (`test:sim:local-chat:android:live`) | dispatch (input `run_android_local_chat`) |

`ELIZA_UI_SMOKE_CLOUD_LIVE=1` makes the live stack leave first-run UNcompleted so
`cloud-live.spec.ts` can drive cloud onboarding through the UI (the default lane
auto-completes a local first-run so chat/view specs land on a ready agent).

## Follow-on real lanes (recipes, not yet wired)

### iOS on-device local provisioning + chat

macOS-runner analog of `android-local-chat`:
`bun run --cwd packages/app test:sim:local-chat:ios:full-bun` (real on-device
GGUF reply). Needs a macOS runner + a booted simulator; use
`--require-installed` so a missing device **fails** instead of warning.

### Real desktop local provisioning (Electrobun)

`test/electrobun-packaged/*` already builds a real model-less `AgentRuntime`
(`live-api.ts`), but its `playwright.electrobun.packaged.config.ts` is referenced
**only by `lint`** — no `test:*` script and no workflow runs it, and
`release-electrobun.yml` invokes `test:desktop:packaged` / `:playwright` scripts
that **exist in no `package.json`**, which `validate-regression-matrix.mjs`
rubber-stamps by string-matching the command text. To make this real: define
those scripts to actually run the packaged config, run them on the macOS/Windows
runners release CI already provisions, add a spec that does **not** set
`ELIZA_DESKTOP_TEST_API_BASE` (so `_startAgent()` boots the embedded agent
through the real `agentStart` RPC instead of short-circuiting to `external`
mode), and harden `validate-regression-matrix.mjs` to assert each referenced
`bun run <script>` is defined.

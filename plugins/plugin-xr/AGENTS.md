# @elizaos/plugin-xr

WebXR audio/video streaming for elizaOS — Quest 3 and XReal glasses.

## Purpose / role

Adds a WebXR streaming surface to an Eliza agent: a WebSocket server accepts
connections from XR headsets (Quest 3, XReal, or a browser simulator), pipes
microphone audio through the runtime's TRANSCRIPTION model, and routes the
transcript through the standard message pipeline. Voice responses are generated
via the TEXT_TO_SPEECH model and sent back as binary audio frames. The plugin
is opt-in — register `xrPlugin` in your character's plugins array.

## WEBXR_STATUS — what "XR" renders, precisely (read before claiming more)

There are **two** XR surfaces; do not conflate them.

1. **Flat view-host** (`xr-view-host.ts`) — a screen-space (head-locked) 2D DOM
   shell that loads a plugin view bundle. `SpatialSurface modality="xr"` here is
   GUI's React tree with larger cell sizing / touch targets
   (`packages/ui/src/spatial/primitives.tsx` — `fontSize * (modality === "xr" ? 1.25 : 1)`;
   `packages/ui/src/spatial/dom.tsx`). This is the headset-iframe path and is
   genuinely flat. It is NOT spatial.

2. **`XRSpatialScene`** (`packages/ui/src/spatial/xr-scene.tsx`) — a **real 3D
   spatial renderer**: authored views are placed as panels at world poses
   (position, orientation, depth), billboarded to face a movable headset camera,
   projected to screen by a pinhole camera (`xr-scene-math.ts`). Controller world
   rays are intersected with panel planes; the nearest hit maps back to a DOM
   element — controller targeting + hit-testing are real, computed 3D facts, and a
   `move` SpatialAction relocates a panel in world space. This satisfies the
   #9968 renderer contract: 3D placement, depth, follow-mode, and ray hit-testing
   exist.

   **Scope / honesty:** `XRSpatialScene` is **simulator-grade** — it composites
   panels with CSS transforms so the whole pose→ray→hit→press→drag loop is
   deterministic and headless-testable in CI. Compositing those same panels into a
   headset's **WebGL** layer on-device (an immersive `requestSession`
   `XRWebGLLayer` render loop) is the **native renderer's** job and is still out
   of scope. The math core (`xr-scene-math.ts`) supports arbitrarily-oriented
   planes for that on-device path.

What IS real and tested: the WebSocket streaming protocol (`protocol.ts`), the
flat view-host route, the **single canonical IWER harness** under `simulator/`
(`navigator.xr` polyfill on an emulated Quest 3 — #9941 deduped; facewear
re-exports it) that starts a session, sets head/controller/hand poses, aims a
controller ray, computes the hit, presses, drags, and captures screenshot +
per-frame pose/hit JSON. Coverage: `simulator/e2e/harness.spec.ts` (flat target),
`simulator/e2e/scene.spec.ts` (the 3D `XRSpatialScene` over the gallery views),
`simulator/e2e/hand-input.spec.ts` (real `XRHandInput` hand-tracking: pinch aim →
computed hit → hand `select` firing the authored view handler; pinch-grab drags a
panel in world space), and `simulator/e2e/gaze-input.spec.ts` (head-gaze *aiming*
→ hit). **Gaze honesty:** IWER 2.2.1 cannot surface a live `targetRayMode: "gaze"`
/ `"transient-pointer"` input source (both are enum-only; the only live sources —
controller + hand — are hard-coded to `tracked-pointer`), so interactive gaze
*selection* is NOT emulable and is NOT tested; only head-gaze aiming is. That
blocker is pinned by an executable assertion in `gaze-input.spec.ts` that fails if
a future IWER gains gaze emulation. Every registered view is asserted to place +
render in the 3D scene by
`packages/ui/src/spatial/__tests__/registered-view-parity.test.tsx`.

## Plugin surface

**Service**
- `XRSessionService` (`xr-session`) — WebSocket server on port 31338 (default).
  Manages per-connection lifecycle, delegates audio to `AudioPipeline` and
  camera frames to `VisionPipeline`, routes transcripts into the agent message
  pipeline, and sends TTS audio back to the headset.

**Actions**
- `XR_QUERY_VISION` — describes what the user's XR camera currently sees
  (calls `VisionPipeline.describeFrame` → `ModelType.IMAGE_DESCRIPTION`).
  Only validates when a recent camera frame exists.
- `XR_OPEN_VIEW` — opens a named view panel on the headset (sends
  `view_open` control message).
- `XR_CLOSE_VIEW` — closes a named view (or all views if no id given).
- `XR_SWITCH_VIEW` — brings a view to the foreground without closing others.
- `XR_LIST_VIEWS` — enumerates views with `viewType: "xr"` from all loaded
  plugins and optionally sends the catalog to the device.
- `XR_RESIZE_VIEW` — resizes/repositions the active panel (`scale`,
  `distance`, `fullscreen` options).

**Provider**
- `XR_SESSION` (`xr-context.ts`) — injects connected device list and camera
  state into the agent context block when at least one headset is connected.

**Routes** (all under `/api/xr/`)
- `GET /xr/status` — JSON list of connected sessions and camera-frame state.
- `GET /xr/connect` — HTML page with QR code for pairing a headset.
- `GET /xr/views` — JSON list of all `viewType: "xr"` views registered by
  loaded plugins, plus active connections.
- `GET /xr/view-host/:id` — self-contained HTML shell that dynamically imports
  a plugin view bundle and renders it with an XR-optimised chrome.
- `GET /xr/simulator.js` — serves the built WebXR emulator bundle (only
  available after `bun run build:all`).

## Layout

```
plugins/plugin-xr/
  src/
    index.ts                  Plugin entry — exports xrPlugin and public types
    protocol.ts               Wire types: XRClientControl, XRServerControl,
                              XRBinaryHeader, XRTTSAudioHeader; encode/decode helpers
    actions/
      xr-query-vision.ts      XR_QUERY_VISION action
      xr-view-actions.ts      XR_OPEN/CLOSE/SWITCH/LIST/RESIZE_VIEW actions
    providers/
      xr-context.ts           XR_SESSION provider
    services/
      xr-session-service.ts   XRSessionService (WebSocket server, main orchestrator)
      audio-pipeline.ts       AudioPipeline — buffers audio chunks, flushes to
                              TRANSCRIPTION model after 2 s or 1.5 s silence
      vision-pipeline.ts      VisionPipeline — stores latest camera frame (max age
                              10 s), calls IMAGE_DESCRIPTION model on demand
    routes/
      xr-status.ts            GET /xr/status
      xr-connect.ts           GET /xr/connect
      xr-views.ts             GET /xr/views
      xr-view-host.ts         GET /xr/view-host/:id
      xr-simulator-route.ts   GET /xr/simulator.js
    __tests__/
      audio-pipeline.test.ts
      protocol.test.ts
      vision-pipeline.test.ts
      xr-bundle-coverage.test.ts
      xr-feature-parity.test.ts
      xr-functional-parity.test.ts
      xr-view-host.test.ts
      xr-view-host-http.test.ts
  simulator/                  Browser-side WebXR emulator (Vite build)
```

## Commands

```bash
bun run --cwd plugins/plugin-xr typecheck
bun run --cwd plugins/plugin-xr lint
bun run --cwd plugins/plugin-xr test
bun run --cwd plugins/plugin-xr build
bun run --cwd plugins/plugin-xr build:all    # also builds simulator/
bun run --cwd plugins/plugin-xr simulator:build
bun run --cwd plugins/plugin-xr simulator:watch
bun run --cwd plugins/plugin-xr clean
```

## Config / env vars

| Var | Default | Required | Purpose |
|-----|---------|----------|---------|
| `XR_WS_PORT` | `31338` | no | WebSocket server port |
| `XR_AGENT_URL` | `http://localhost:<agent-port>` | no | Public base URL sent to the headset for view bundles |
| `XR_APP_URL` | derived from `VITE_PORT` | no | URL shown on the `/xr/connect` pairing page |

The plugin sets `config: { XR_WS_PORT: 31338 }` in the Plugin object so the
runtime exposes it via `runtime.getSetting("XR_WS_PORT")`.

The agent must have a TRANSCRIPTION model and TEXT_TO_SPEECH model configured
(e.g., via `@elizaos/plugin-openai` or a local inference plugin) for audio
streaming to work. IMAGE_DESCRIPTION is required for `XR_QUERY_VISION`.

## How to extend

**Add an action** — create `src/actions/<name>.ts`, implement `Action` from
`@elizaos/core`, get `XRSessionService` via
`runtime.getService<XRSessionService>(XR_SERVICE_TYPE)`, then add the import
and the object to the `actions` array in `src/index.ts`.

**Add a provider** — create `src/providers/<name>.ts`, implement `Provider`,
add to `providers` array in `src/index.ts`.

**Add a route** — create `src/routes/<name>.ts`, implement `Route`, add to
`routes` array in `src/index.ts`.

**Expose a view in XR** — in any other plugin, add a `views` array entry with
`viewType: "xr"`. `XR_LIST_VIEWS` and `GET /xr/views` collect views with this
field across all loaded plugins at runtime.

## Conventions / gotchas

- **WebXR requires HTTPS on device.** The `/xr/connect` page warns when the
  URL is plain HTTP. Use a local tunnel (e.g., `cloudflared`) and set
  `XR_APP_URL` to the HTTPS tunnel URL.
- **Binary frame framing** is defined in `src/protocol.ts`: 4-byte big-endian
  header length, then UTF-8 JSON header, then raw payload. Use
  `encodeBinaryFrame` / `decodeBinaryFrame` from that module — do not
  reimplement the framing.
- **Audio buffering** — `AudioPipeline` accumulates chunks and flushes after
  2 000 ms of audio or 1 500 ms of silence. Chunks shorter than 512 bytes are
  dropped. `pcm-f32` encoding (ScriptProcessorNode fallback) is wrapped in a
  WAV header before being passed to TRANSCRIPTION.
- **Simulator bundle** — `simulator/` is a separate Vite project. Run
  `bun run build:all` (or `simulator:build`) before the `/xr/simulator.js`
  route will serve anything. The route returns 404 until the bundle exists.
- **`XR_AGENT_URL`** must be a reachable URL from inside the XR headset
  browser when loading view bundles. `localhost` will only work when testing
  on the same machine via the browser simulator.
- See repo root `AGENTS.md` for repo-wide architecture rules, logger
  conventions, ESM requirements, and naming standards.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->

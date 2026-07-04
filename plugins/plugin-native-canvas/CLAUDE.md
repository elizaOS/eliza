# @elizaos/capacitor-canvas

Capacitor plugin that provides a multi-layer 2D canvas, drawing primitives, web view embedding, and an A2UI bridge for elizaOS Eliza agents running on browser, node (Electrobun), iOS, and Android.

## Purpose / role

This is a [Capacitor](https://capacitorjs.com/) plugin, not an elizaOS runtime plugin registered via `Plugin` object. It exposes the `Canvas` singleton (registered as `"ElizaCanvas"`) that any Eliza agent UI surface can import from `@elizaos/capacitor-canvas`. On web/browser it is backed by `CanvasWeb` (HTML5 Canvas API + iframes). On iOS (Swift) and Android (Kotlin) it uses the platform native implementation. The plugin is opt-in — consumers must import and call `Canvas.*` methods.

## Plugin surface

This is a Capacitor plugin, not an elizaOS action/provider/service plugin. It registers one Capacitor plugin object:

- **`Canvas`** (`src/index.ts`) — the `CanvasPlugin` instance, registered as `"ElizaCanvas"` via `registerPlugin`. Web fallback: `CanvasWeb`.

### Canvas API methods (from `CanvasPlugin` interface)

**Canvas lifecycle:**
- `create({ size, backgroundColor? })` — allocate a new canvas, returns `{ canvasId }`
- `destroy({ canvasId })` — free canvas and all its layers
- `attach({ canvasId, element })` — mount canvas into a DOM element; also wires touch handlers
- `detach({ canvasId })` — remove canvas from DOM
- `resize({ canvasId, size })` — resize, preserving pixel data

**Layer management:**
- `createLayer({ canvasId, layer })` — add a named layer with opacity/zIndex/transform; returns `{ layerId }`
- `updateLayer({ canvasId, layerId, layer })` — change visibility, opacity, zIndex, name, transform
- `deleteLayer({ canvasId, layerId })` — remove a layer
- `getLayers({ canvasId })` — list all layers with their properties

**Drawing primitives:**
- `drawRect(...)` — fill/stroke rectangle with optional corner radius, gradient, blend mode, shadow
- `drawEllipse(...)` — fill/stroke ellipse
- `drawLine(...)` — stroked line segment
- `drawPath(...)` — arbitrary path via `CanvasDrawPathCommand[]` (moveTo, lineTo, bezierCurveTo, arc, ellipse, rect, closePath, …)
- `drawText(...)` — positioned text with font, size, color, align, baseline, maxWidth
- `drawImage(...)` — draw `CanvasImageData` (base64) or URL, with optional srcRect/destRect crop
- `drawBatch({ canvasId, commands })` — execute a `CanvasDrawBatchCommand[]` array in sequence
- `clear({ canvasId, rect?, layerId? })` — clear whole canvas or a rect, optionally scoped to a layer

**Export / transform:**
- `toImage({ canvasId, format?, quality?, layerIds? })` — composite layers into `CanvasImageData` (base64 + format + dimensions)
- `getPixelData({ canvasId, rect? })` — raw `Uint8ClampedArray`
- `setTransform({ canvasId, transform })` / `resetTransform({ canvasId })` — global canvas transform (translate, scale, rotate, skew)
- `setTouchEnabled({ canvasId, enabled })` — gate touch/mouse event emission

**Web view methods:**
- `navigate({ url, placement? })` — load URL in `"inline"` iframe, `"fullscreen"` overlay, or `"popup"` window; intercepts `eliza://` deep links immediately
- `eval({ script })` — evaluate JS in the active web view via postMessage; 5 s timeout
- `snapshot(options?)` — capture inline web view to base64 PNG/JPEG/WEBP; same-origin via SVG foreignObject, unavailable frame on cross-origin
- `a2uiPush({ messages?, jsonl?, payload? })` — push A2UI messages to the web view (tries `window.elizaA2UI` bridge first, then postMessage)
- `a2uiReset()` — reset A2UI state in the web view

**Events (`addListener` / `removeAllListeners`):**
- `"touch"` → `CanvasTouchEvent` — pointer/touch input on the canvas (start, move, end, cancel)
- `"render"` → `CanvasRenderEvent` — frame/FPS telemetry
- `"webViewReady"` → `WebViewReadyEvent` — navigation completed
- `"navigationError"` → `NavigationErrorEvent` — load failure
- `"deepLink"` → `DeepLinkEvent` — `eliza://` URL intercepted
- `"a2uiAction"` → `A2UIActionEvent` — action triggered from web view content

## Layout

```
plugins/plugin-native-canvas/
  src/
    index.ts          Entry point — registerPlugin("ElizaCanvas", { web: loadWeb }) where loadWeb is a lazy dynamic import of CanvasWeb
    definitions.ts    All TypeScript interfaces and types (CanvasPlugin, CanvasLayer,
                      CanvasDrawBatchCommand, A2UIMessage, WebView* events, etc.)
    web.ts            CanvasWeb — full HTML5 Canvas + iframe web view implementation
  ios/Sources/
    CanvasPlugin/
      CanvasPlugin.swift   Native iOS implementation (UIKit, CoreGraphics, WebKit)
  android/src/main/
    java/ai/eliza/plugins/canvas/
      CanvasPlugin.kt      Native Android implementation
  ElizaosCapacitorCanvas.podspec   CocoaPods spec for iOS
  rollup.config.mjs    Bundles ESM → IIFE (dist/plugin.js) + CJS (dist/plugin.cjs.js)
  tsconfig.json
  package.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-canvas clean           # remove build output
bun run --cwd plugins/plugin-native-canvas build           # build package artifacts
bun run --cwd plugins/plugin-native-canvas typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-canvas lint            # mutating Biome check
bun run --cwd plugins/plugin-native-canvas lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-canvas format          # write formatting
bun run --cwd plugins/plugin-native-canvas format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-canvas test            # run package tests
bun run --cwd plugins/plugin-native-canvas prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-canvas watch           # watch TypeScript sources
bun run --cwd plugins/plugin-native-canvas build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

This plugin reads no environment variables. Configuration is entirely call-time via method arguments. There are no required env vars.

## How to extend

### Add a new canvas method

1. Declare the method signature in `src/definitions.ts` inside `CanvasPlugin`.
2. Implement it in `src/web.ts` in the `CanvasWeb` class.
3. Add native handlers/implementations in `ios/Sources/CanvasPlugin/CanvasPlugin.swift` and `android/src/main/java/ai/eliza/plugins/canvas/CanvasPlugin.kt`.
4. Re-export any new types from `src/index.ts` via `export * from "./definitions"` (already done).

### Add a new event

1. Define the event payload interface in `src/definitions.ts`.
2. Add an `addListener` overload in `CanvasPlugin` with the new event name.
3. Call `this.notifyListeners(eventName, payload)` from the appropriate place in `CanvasWeb` (or native implementations).
4. Add the event type to the `CanvasEventData` union in `src/web.ts`.

## Conventions / gotchas

- **This is a Capacitor plugin, not an elizaOS runtime plugin.** It does not export an elizaOS `Plugin` object and is not loaded via `AgentRuntime`. Import `Canvas` from `@elizaos/capacitor-canvas` in UI code.
- **Web implementation is the reference.** `CanvasWeb` in `src/web.ts` is the fully implemented reference. iOS Swift and Android Kotlin implementations must match its behaviour.
- **Layer canvases are absolute-positioned siblings.** When `createLayer` appends a layer canvas, it goes into `managed.canvas.parentElement`, not inside the canvas itself. The host container must be `position: relative` for z-ordering to work.
- **`snapshot()` requires inline or fullscreen placement.** It throws on popup placement because there is no accessible iframe. Cross-origin iframes render an unavailable frame instead of the real content.
- **`eval()` uses postMessage with a 5 s timeout.** The web view must handle `eliza:eval` messages and reply with `eliza:evalResult`. If the page does not implement this, `eval()` rejects.
- **`a2uiPush` prefers `window.elizaA2UI`.** The A2UI runtime sets `window.elizaA2UI = { push, reset }`. Only if that bridge is absent does it fall back to postMessage.
- **Touch handlers are set up on `attach()`.** `setTouchEnabled` gates event emission but does not add/remove DOM listeners; always call `attach()` before enabling touch.
- **Build outputs two formats.** `rollup.config.mjs` produces `dist/plugin.js` (IIFE, for `<script>` tags / unpkg) and `dist/plugin.cjs.js` (CJS). The ESM build (`dist/esm/`) comes from `tsc` directly.
- **peerDependency: `@capacitor/core ^8.3.1`.** The host project must install this. It is not bundled.
- **iOS deployment target: 15.0. Swift 5.9. Frameworks: UIKit, CoreGraphics, WebKit.**
- See the root [AGENTS.md](../../AGENTS.md) for repo-wide architecture rules, logging conventions, and git workflow.

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

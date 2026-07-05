# @elizaos/plugin-computeruse

Desktop automation for elizaOS agents — screenshots, mouse/keyboard control, browser CDP automation, window management, and a multi-display scene model.

Ported from [`coasty-ai/open-computer-use`](https://github.com/coasty-ai/open-computer-use) (Apache 2.0).

## Purpose / role

Adds real desktop control to an Eliza agent: taking screenshots, clicking/typing/scrolling, managing windows, automating web browsers via CDP (puppeteer-core), and building a structured `Scene` from displays, accessibility tree, OCR, and process list so the agent can reason about what is visible. Opt-in: the plugin auto-enables only when `COMPUTER_USE_ENABLED=1` is set (see `autoEnable` in `src/index.ts`). Requires a headful display session on macOS/Linux; headless browser mode is supported.

File operations belong to the FILE action; shell/terminal access belongs to the SHELL action — this plugin does not expose them.

## Plugin surface

### Actions

| Name | File | What it does |
|------|------|--------------|
| `COMPUTER_USE` | `src/actions/use-computer.ts` | Umbrella desktop action: `screenshot`, `click`, `click_with_modifiers`, `double_click`, `right_click`, `mouse_move`, `middle_click`, `mouse_down`, `mouse_up`, `type`, `key`, `key_combo`, `key_down`, `key_up`, `scroll`, `drag` (single segment or multi-point `path`), `get_cursor_position`, `detect_elements`, `ocr`, `open` (file/URL/folder via the OS default handler), `launch` (start an app → returns pid). `mouse_down/up` + `key_down/up` are real press-and-hold primitives (nutjs `pressButton`/`pressKey` without release — back hold-drags, marquee, held modifiers); they require the nutjs driver. Requires `OWNER` role. Subactions are promoted to virtual top-level actions (`COMPUTER_USE_CLICK`, etc.) via `promoteSubactionsToActions`. |
| `WINDOW` | `src/actions/window.ts` | Window management: `list`, `focus`, `switch`, `arrange`, `move`, `minimize`, `maximize`, `restore`, `close`, `get_current_window_id`, `get_application_windows`, `set_bounds` (position + size). Also promoted to `WINDOW_FOCUS`, etc. |
| `CLIPBOARD` | `src/actions/clipboard.ts` | Host clipboard read/write (`read`, `write`) — trycua/cua parity. Promoted to `CLIPBOARD_READ` / `CLIPBOARD_WRITE`. macOS pbcopy/pbpaste, Linux wl-clipboard/xclip, Windows PowerShell `Get-Clipboard` / `Set-Clipboard`. |
| `COMPUTER_USE_AGENT` | `src/actions/use-computer-agent.ts` | High-level "give me a goal, click my way there" loop (WS7). Selects an agent loop by model string (#9170 M10, default `local-grounder` = Brain → Cascade) and runs predictStep → dispatch up to `maxSteps`, through a callback-middleware pipeline (#9170 M11: operator-normalizer + trajectory by default; `maxDurationMs` budget cap + `imageRetentionLast` window opt-in). Emits trajectory events as structured log lines and on `report.trajectory`. |

### Providers

| Name | File | What it injects |
|------|------|----------------|
| `computerState` | `src/providers/computer-state.ts` | Platform info, screen dimensions, available capabilities, recent actions, approval queue. Gate: `browser/files/terminal/automation/admin` contexts. |
| `scene` | `src/providers/scene.ts` | Live desktop scene (displays, focused window, apps, OCR boxes, AX nodes, VLM annotations) via `SceneBuilder`. Refreshed once per turn; serialized as token-efficient JSON fence. Gate: `browser/automation/admin` contexts. |

### Services

| Name | `serviceType` | File | What it does |
|------|--------------|------|--------------|
| `ComputerUseService` | `"computeruse"` | `src/services/computer-use-service.ts` | Central service: input dispatch, screenshot capture, browser CDP session, window ops, approval-manager wiring, `SceneBuilder` lifecycle. |
| `VisionContextProvider` | `"vision-context"` | `src/services/vision-context-provider.ts` | Surfaces a `VisionContext` snapshot (open apps, focused window, recent actions, current task goal) for downstream consumers (e.g. plugin-vision). |

### Routes

All paths are under `/api/computer-use/` and implemented in `src/routes/computer-use-compat-routes.ts`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/computer-use/approvals` | List pending approval requests |
| GET | `/api/computer-use/approvals/stream` | SSE stream of approval events (public) |
| POST | `/api/computer-use/approval-mode` | Change the active `COMPUTER_USE_APPROVAL_MODE` |
| POST | `/api/computer-use/approvals/:id` | Approve or deny a pending action |

## Layout

```
src/
  index.ts                   Plugin entry — assembles and exports computerUsePlugin
  types.ts                   All shared types (ApprovalMode, ComputerUseConfig, DesktopActionParams, …)
  approval-manager.ts        ComputerUseApprovalManager — queues pending actions, applies approval mode
  register-routes.ts         Route registration helper

  actions/
    use-computer.ts          COMPUTER_USE parent action + subaction table
    use-computer-agent.ts    COMPUTER_USE_AGENT (WS7 autonomous loop)
    window.ts                WINDOW parent action
    window-handlers.ts       Per-verb handlers called by window.ts
    clipboard.ts             clipboardAction (CLIPBOARD parent action) — registered in index.ts; promoted to CLIPBOARD_READ / CLIPBOARD_WRITE
    helpers.ts               resolveActionParams, buildScreenshotAttachment, …

  actor/                     WS7 autonomous desktop loop
    brain.ts                 Brain — sends display PNGs to IMAGE_DESCRIPTION model, produces BrainOutput
    cascade.ts               Cascade (ScreenSeekeR) — Brain → Actor → ProposedAction
    actor.ts                 Actor interface + OsAtlasProActor + OcrCoordinateGroundingActor
    dispatch.ts              dispatch() — executes a ProposedAction via ComputerInterface
    computer-interface.ts    ComputerInterface abstraction + makeComputerInterface()
    aosp-input-actor.ts      AOSP-specific actor
    types.ts                 BrainOutput, ProposedAction, …
    index.ts                 Public re-exports

  platform/
    browser.ts               Puppeteer-core CDP browser automation
    capture.ts               captureDisplay / captureAllDisplays
    displays.ts              listDisplays / getPrimaryDisplay
    driver.ts                driverClick / driverType / … (nutjs or legacy shell)
    nut-driver.ts            @nut-tree-fork/nut-js implementation
    windows-list.ts          listWindows / focusWindow / arrangeWindows / getActiveWindow / resizeWindow / …
    launch.ts                openTarget (open file/URL/folder) / launchApp (spawn app → pid)
    clipboard.ts             OS clipboard read/write
    a11y.ts                  Accessibility tree query
    coords.ts                localToGlobal coordinate translation
    wayland-portal.ts        xdg-desktop-portal screenshot sidecar for Wayland
    capabilities.ts          detectPlatformCapabilities
    desktop.ts               High-level desktop helpers
    helpers.ts               Shared platform utilities
    permissions.ts           classifyPermissionDeniedError
    process-list.ts          listProcesses / parsePsOutput
    screenshot-quality.ts    Quality / compression settings for screenshots
    terminal.ts              Terminal session management (internal; not exposed as action)
    file-ops.ts              File primitives (internal; not exposed as action)
    screenshot.ts            Low-level screencapture wrappers
    security.ts              Path + command security checks

  providers/
    computer-state.ts        computerStateProvider
    scene.ts                 sceneProvider

  routes/
    computer-use-routes.ts       handleComputerUseRoutes (full route table)
    computer-use-compat-routes.ts  computerUseRouteHandler() (compat wrapper used by plugin entry)
    sandbox-routes.ts            handleSandboxRoute

  scene/
    scene-builder.ts         SceneBuilder — composes displays + a11y + OCR into Scene
    scene-types.ts           Scene, SceneApp, SceneAppWindow, SceneAxNode, …
    a11y-provider.ts         DarwinAccessibilityProvider / LinuxAccessibilityProvider / …
    apps.ts                  enumerateApps / joinAppsAndWindows
    dhash.ts                 Perceptual hash / dirty-block diffing for change detection
    screen-state.ts          ScreenState + ScreenStateStore — one shared capture/turn (dHash/blockGrid + change events)
    ocr-adapter.ts           OcrProvider / CoordOcrProvider adapter seam
    serialize.ts             serializeSceneForPrompt — token-efficient JSON fence

  services/
    computer-use-service.ts  ComputerUseService (serviceType = "computeruse")
    vision-context-provider.ts  VisionContextProvider (serviceType = "vision-context")
    desktop-control.ts       Low-level desktop control primitives + DesktopControl* types
    index.ts                 Barrel re-exports for services/

  mobile/
    ocr-provider.ts          OcrProvider / CoordOcrProvider interfaces (plugin-vision contributes impls)
    ios-bridge.ts            iOS computer-use bridge
    ios-computer-interface.ts  iOS-specific ComputerInterface implementation
    ios-app-intent-registry.ts  Registry of iOS app intents for automation
    android-bridge.ts        AOSP input bridge
    android-scene.ts         Android scene capture and representation
    android-trajectory.ts    Android action trajectory recording
    mobile-computer-interface.ts  MobileComputerInterface
    mobile-screen-capture.ts Screen capture abstraction for mobile targets
    index.ts                 Mobile public surface

  osworld/
    adapter.ts               OSWorld benchmark adapter
    action-converter.ts      OSWorld action → ComputerInterface translation
    types.ts                 OSWorld-specific type definitions

  parity/                    trycua/cua parity tooling (#9170 M14)
    parity-matrix.ts         machine-checkable capability matrix + validateParityMatrix (guards drift vs the live action surface)
    screenspot.ts            ScreenSpot grounding harness (point-in-bbox scorer + score fold)
    index.ts                 Public re-exports

  sandbox/
    sandbox-driver.ts        Sandbox driver (backend-agnostic)
    docker-backend.ts        Docker backend
    remote-guest.ts          Generic {command,params}→{success,result} RPC seam + RemoteGuestBackend base (#9170 M13)
    wsb-backend.ts           Windows Sandbox provider (RemoteGuestBackend)
    qemu-backend.ts          QEMU provider (RemoteGuestBackend)
    surface-types.ts         Shared surface type definitions
    types.ts                 Sandbox-specific types
    index.ts                 Public re-exports

  security/
    browser-script-policy.ts GHSA-rcvr-766c-4phv — browser_execute disabled by default
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-computeruse build                              # build package artifacts
bun run --cwd plugins/plugin-computeruse typecheck                          # TypeScript typecheck
bun run --cwd plugins/plugin-computeruse lint                               # mutating Biome check
bun run --cwd plugins/plugin-computeruse lint:check                         # read-only Biome check
bun run --cwd plugins/plugin-computeruse format                             # write formatting
bun run --cwd plugins/plugin-computeruse format:check                       # read-only formatting check
bun run --cwd plugins/plugin-computeruse test                               # run package tests
bun run --cwd plugins/plugin-computeruse capture:macos-desktop-evidence     # macos-desktop-evidence evidence capture
bun run --cwd plugins/plugin-computeruse capture:windows-desktop-evidence   # windows-desktop-evidence evidence capture
bun run --cwd plugins/plugin-computeruse postinstall                        # postinstall setup
bun run --cwd plugins/plugin-computeruse record:windows-cua-input           # bun scripts/record-windows-cua-input.mjs
bun run --cwd plugins/plugin-computeruse validate:android-aosp-evidence     # android-aosp-evidence evidence validation
bun run --cwd plugins/plugin-computeruse validate:android-device-evidence   # android-device-evidence evidence validation
bun run --cwd plugins/plugin-computeruse validate:ios-device-evidence       # ios-device-evidence evidence validation
bun run --cwd plugins/plugin-computeruse validate:linux-desktop-evidence    # linux-desktop-evidence evidence validation
bun run --cwd plugins/plugin-computeruse validate:macos-desktop-evidence    # macos-desktop-evidence evidence validation
bun run --cwd plugins/plugin-computeruse validate:platform-evidence         # platform-evidence evidence validation
bun run --cwd plugins/plugin-computeruse validate:windows-desktop-evidence  # windows-desktop-evidence evidence validation
```

## Config / env vars

All read via `runtime.getSetting()` / `process.env`. Core vars are declared in `package.json#agentConfig.pluginParameters`; sandbox vars are read directly.

| Env var | Type | Default | Required | Description |
|---------|------|---------|----------|-------------|
| `COMPUTER_USE_ENABLED` | boolean | `false` | No | Master toggle; also controls `autoEnable` |
| `COMPUTER_USE_SCREENSHOT_AFTER_ACTION` | boolean | `true` | No | Auto-capture screenshot after each desktop action |
| `COMPUTER_USE_ACTION_TIMEOUT_MS` | number | `10000` | No | Per-action timeout in ms |
| `COMPUTER_USE_APPROVAL_MODE` | enum | `"smart_approve"` | No | `full_control` / `smart_approve` / `approve_all` / `off` |
| `COMPUTER_USE_BROWSER_HEADLESS` | boolean | `false` | No | Headless browser (useful in CI) |
| `ELIZA_COMPUTERUSE_DRIVER` | enum | `"nutjs"` | No | Input driver: `nutjs` (@nut-tree-fork/nut-js) or `legacy` (cliclick/xdotool/PowerShell) |
| `COMPUTER_USE_MODE` | enum | `"yolo"` | No | Runtime mode: `yolo` (direct desktop) or `sandbox` (Docker-isolated). Alias: `COMPUTERUSE_MODE` |
| `COMPUTER_USE_SANDBOX_BACKEND` | enum | — | No | Sandbox backend when `COMPUTER_USE_MODE=sandbox`: `"docker"`, `"wsb"` (Windows Sandbox), or `"qemu"`. `docker`/`qemu` need `COMPUTER_USE_SANDBOX_IMAGE`; `wsb` is imageless. Alias: `COMPUTERUSE_SANDBOX_BACKEND` |
| `COMPUTER_USE_SANDBOX_RPC_URL` | string | — | No | VM-provider (wsb/qemu) in-guest computer-server RPC URL (#9170 M13). Default `http://127.0.0.1:<rpcPort>/cua`. Alias: `COMPUTERUSE_SANDBOX_RPC_URL` |
| `COMPUTER_USE_SANDBOX_RPC_PORT` | number | `8000` | No | Host-forwarded guest RPC port for wsb/qemu. Alias: `COMPUTERUSE_SANDBOX_RPC_PORT` |
| `COMPUTER_USE_SANDBOX_IMAGE` | string | — | No | Docker image to use for sandbox mode. Alias: `COMPUTERUSE_SANDBOX_IMAGE` |

Power-user escape hatches read directly via `process.env` (not declared as plugin parameters):

| Env var | Type | Default | Description |
|---------|------|---------|-------------|
| `COMPUTERUSE_PS_HOST` | `0` to disable | enabled | Windows-only warm PowerShell host (`ps-host.ts`) that amortizes the cold-spawn AV tax. Set `0` to force every spawn through one-shot `powershell.exe`. |
| `ELIZA_COMPUTERUSE_PS_TIMEOUT_MS` | number | unset | Windows-only **floor** for every PowerShell/WinRT spawn budget (capture, clipboard, ps-host startup, window enumeration/ops in `windows-list.ts`). Applied via `psSpawnTimeoutMs` — only ever RAISES a call site's default, never lowers it. Raise it on Defender-heavy hosts where cold `powershell.exe` spawns exceed the default budgets and false-fail with `ETIMEDOUT` (#9581). Mirrors `ELIZA_WAYLAND_PORTAL_TIMEOUT_MS`. |

`BROWSER_EXECUTE_DISABLED` is declared in `package.json#agentConfig.pluginParameters` but is **inert**: `browser_execute` is unconditionally disabled in `src/security/browser-script-policy.ts` (`isBrowserExecuteAllowed()` always returns `false`, GHSA-rcvr-766c-4phv). No setting re-enables it.

## How to extend

### Add a new desktop action verb to COMPUTER_USE

1. Add the verb string to the `action` enum in `src/types.ts` (`DesktopActionType`).
2. Add a handler branch in the `ComputerUseService` dispatch switch in `src/services/computer-use-service.ts`.
3. Add the low-level platform function in the appropriate `src/platform/*.ts` file.
4. Update the `parameters[].schema.enum` in `src/actions/use-computer.ts` so the planner sees it.
5. `promoteSubactionsToActions` will auto-promote `COMPUTER_USE_<VERB>` — no extra registration needed.

### Add a new window operation

Follow the same pattern in `src/actions/window.ts` / `src/actions/window-handlers.ts` / `src/platform/windows-list.ts`.

### Add a new provider

1. Create `src/providers/<name>.ts` exporting a `Provider` object.
2. Import and add it to the `providers` array in `src/index.ts`.

### Add a route

Add a `Route` object to `computerUseRoutes` in `src/index.ts`, implement the handler in `src/routes/`.

### Register an OCR provider (from another plugin)

Call the module-level `registerCoordOcrProvider(provider)` exported from `src/mobile/ocr-provider.ts` (not a method on `ComputerUseService`). plugin-vision does this at boot to contribute its hierarchical OCR adapter.

### Register a Set-of-Marks provider (from another plugin)

Call `registerSetOfMarksProvider(provider)` (same module, `src/mobile/ocr-provider.ts`). When registered, `detect_elements` prefers it: it returns a deduplicated, **1-indexed** set of numbered marks (GGUF YOLO icons + OCR text fused, icon-over-text suppression + NMS) plus an optional numbered-overlay PNG under `data.setOfMarks.overlay`. Each mark carries a `center` click target the VLM's chosen number resolves to. plugin-vision contributes the implementation (`som.ts` + `set-of-marks-provider.ts`); with no provider registered, `detect_elements` falls back to OCR-only text elements.

### Register an agent loop (model-string → loop)

`COMPUTER_USE_AGENT` selects its loop from a model string via the registry in `src/actor/agent-loop.ts` (#9170 M10) — trycua/cua parity. Every loop implements the same `predictStep` (observe + plan the next action) / `predictClick` (ground a target to a coordinate) seam. The built-in `local-grounder` wraps the existing Brain → Cascade (ScreenSeekeR) and exposes the M5 grounding cache through `predictClick`; it is the match-anything fallback. Register a provider-specific loop (Anthropic / OpenAI `computer-use-preview` / a remote grounder) with `registerAgentLoop({ name, matches: matchesModelFamily("anthropic"), create, priority })`; the runner reads the active model string from the `COMPUTER_USE_AGENT_LOOP` setting/env (default `local-grounder`).

## Conventions / gotchas

- **Approval flow**: every destructive action passes through `ComputerUseApprovalManager`. The default mode is `smart_approve` — only read-only `SAFE_COMMANDS` auto-approve, and destructive verbs (terminal execute, file write/delete) require explicit human approval. Switch to `full_control` (auto-approve everything), `approve_all`, or `off` (deny all) via env or the `/api/computer-use/approval-mode` route.
- **`browser_execute` is always disabled** (GHSA-rcvr-766c-4phv) — `isBrowserExecuteAllowed()` returns `false` unconditionally; no setting re-enables it. Use `dom`, `clickables`, `click`, `type`, `navigate`, `screenshot` browser subactions instead.
- **Coordinate system**: each display has its own local coordinate space. `src/platform/coords.ts` translates local→global when needed. Always pass `displayId` when targeting a specific monitor.
- **nutjs native bindings**: `@nut-tree-fork/nut-js` requires native compilation. If the build fails, set `ELIZA_COMPUTERUSE_DRIVER=legacy` to fall back to shell tools.
- **Scene is per-turn**: `sceneProvider` calls `SceneBuilder.onAgentTurn()` once per turn. Code that needs the scene outside a provider turn should call `ComputerUseService.getCurrentScene()` or `refreshScene("active")`.
- **WS7 trajectory events**: `COMPUTER_USE_AGENT` emits `logger.info` lines with `evt: "computeruse.agent.step"`. These are picked up by plugin-trajectory-logger via log capture — no direct dependency.
- **Platform evidence**: `docs/ios-device-validation.json`, `docs/android-device-validation.json`, `docs/android-aosp-validation.json`, `docs/macos-desktop-validation.json`, `docs/linux-desktop-validation.json`, and `docs/windows-desktop-validation.json` are the release evidence manifests. Keep incomplete live-device checks in `requires_device_evidence`; use `validate:platform-evidence -- --require-complete` only for release gates that truly have artifacts for every required platform check.
- **Mobile surface**: `src/mobile/` is real but constrained. Read `docs/IOS_CONSTRAINTS.md` and `docs/ANDROID_CONSTRAINTS.md` before touching mobile code.
- **OSWorld benchmark**: `src/osworld/` adapts the plugin to the OSWorld desktop benchmark format. Not part of normal agent runtime.
- **Parity matrix (#9170 M14)**: `src/parity/parity-matrix.ts` is the machine-checkable trycua/cua capability map. `validateParityMatrix(actionNames)` is asserted in the test suite — adding a verb to the matrix without registering it (or renaming a promoted action) fails CI, so the map can't silently drift. `src/parity/screenspot.ts` scores click-grounding (point-in-bbox) for any grounder.
- **Further reading**: `docs/MULTI_MONITOR.md`, `docs/SCENE_BUILDER.md`, `docs/MOBILE_ASSISTANT_ROUTING.md`, `docs/AOSP_SYSTEM_APP.md`, `docs/TEST_LANES_COMPUTERUSE_VISION.md` (unit vs real-driver lanes, per-OS reqs, and the Windows non-interactive-session input gotcha).

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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->

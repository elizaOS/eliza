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
| `COMPUTER_USE` | `src/actions/use-computer.ts` | Umbrella desktop action: `screenshot`, `click`, `click_with_modifiers`, `double_click`, `right_click`, `mouse_move`, `type`, `key`, `key_combo`, `scroll`, `drag`, `detect_elements`, `ocr`. Requires `OWNER` role. Subactions are promoted to virtual top-level actions (`COMPUTER_USE_CLICK`, etc.) via `promoteSubactionsToActions`. |
| `WINDOW` | `src/actions/window.ts` | Window management: `list`, `focus`, `switch`, `arrange`, `move`, `minimize`, `maximize`, `restore`, `close`. Also promoted to `WINDOW_FOCUS`, etc. |
| `COMPUTER_USE_AGENT` | `src/actions/use-computer-agent.ts` | High-level "give me a goal, click my way there" loop (WS7). Runs Brain → Cascade → dispatch up to `maxSteps` iterations, emitting trajectory events as structured log lines. |

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
    clipboard.ts             clipboardAction (CLIPBOARD parent action) — defined but NOT registered in index.ts
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
    windows-list.ts          listWindows / focusWindow / arrangeWindows / …
    clipboard.ts             OS clipboard read/write
    a11y.ts                  Accessibility tree query
    coords.ts                localToGlobal coordinate translation
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
    android-bridge.ts        AOSP input bridge
    mobile-computer-interface.ts  MobileComputerInterface
    index.ts                 Mobile public surface

  osworld/
    adapter.ts               OSWorld benchmark adapter
    action-converter.ts      OSWorld action → ComputerInterface translation
    types.ts                 OSWorld-specific type definitions

  sandbox/
    sandbox-driver.ts        Sandbox driver (Docker/QEMU backends)
    docker-backend.ts        Docker backend
    qemu-backend.ts          QEMU backend
    surface-types.ts         Shared surface type definitions
    types.ts                 Sandbox-specific types
    index.ts                 Public re-exports

  security/
    browser-script-policy.ts GHSA-rcvr-766c-4phv — browser_execute disabled by default
```

## Commands

Only scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-computeruse build       # Bun.build (build.ts) → dist/
bun run --cwd plugins/plugin-computeruse test        # vitest run
bun run --cwd plugins/plugin-computeruse typecheck   # tsgo --noEmit
```

`postinstall` runs `scripts/ensure-platform-deps.mjs` to check native dep availability (nutjs binaries, cliclick, xdotool).

## Config / env vars

All read via `runtime.getSetting()` / `process.env`. Declared in `package.json#agentConfig.pluginParameters`.

| Env var | Type | Default | Required | Description |
|---------|------|---------|----------|-------------|
| `COMPUTER_USE_ENABLED` | boolean | `false` | No | Master toggle; also controls `autoEnable` |
| `COMPUTER_USE_SCREENSHOT_AFTER_ACTION` | boolean | `true` | No | Auto-capture screenshot after each desktop action |
| `COMPUTER_USE_ACTION_TIMEOUT_MS` | number | `10000` | No | Per-action timeout in ms |
| `COMPUTER_USE_APPROVAL_MODE` | enum | `"full_control"` | No | `full_control` / `smart_approve` / `approve_all` / `off` |
| `COMPUTER_USE_BROWSER_HEADLESS` | boolean | `false` | No | Headless browser (useful in CI) |
| `ELIZA_COMPUTERUSE_DRIVER` | enum | `"nutjs"` | No | Input driver: `nutjs` (@nut-tree-fork/nut-js) or `legacy` (cliclick/xdotool/PowerShell) |

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

## Conventions / gotchas

- **Approval flow**: every destructive action passes through `ComputerUseApprovalManager`. The default mode is `full_control` (auto-approve). Switch to `smart_approve` or `approve_all` via env or the `/api/computer-use/approval-mode` route. `off` denies all.
- **`browser_execute` is always disabled** (GHSA-rcvr-766c-4phv) — `isBrowserExecuteAllowed()` returns `false` unconditionally; no setting re-enables it. Use `dom`, `clickables`, `click`, `type`, `navigate`, `screenshot` browser subactions instead.
- **Coordinate system**: each display has its own local coordinate space. `src/platform/coords.ts` translates local→global when needed. Always pass `displayId` when targeting a specific monitor.
- **nutjs native bindings**: `@nut-tree-fork/nut-js` requires native compilation. If the build fails, set `ELIZA_COMPUTERUSE_DRIVER=legacy` to fall back to shell tools.
- **Scene is per-turn**: `sceneProvider` calls `SceneBuilder.onAgentTurn()` once per turn. Code that needs the scene outside a provider turn should call `ComputerUseService.getCurrentScene()` or `refreshScene("active")`.
- **WS7 trajectory events**: `COMPUTER_USE_AGENT` emits `logger.info` lines with `evt: "computeruse.agent.step"`. These are picked up by plugin-trajectory-logger via log capture — no direct dependency.
- **Mobile surface**: `src/mobile/` is real but constrained. Read `docs/IOS_CONSTRAINTS.md` and `docs/ANDROID_CONSTRAINTS.md` before touching mobile code.
- **OSWorld benchmark**: `src/osworld/` adapts the plugin to the OSWorld desktop benchmark format. Not part of normal agent runtime.
- **Further reading**: `docs/MULTI_MONITOR.md`, `docs/SCENE_BUILDER.md`, `docs/MOBILE_ASSISTANT_ROUTING.md`, `docs/AOSP_SYSTEM_APP.md`.

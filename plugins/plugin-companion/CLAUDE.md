# @elizaos/plugin-companion

VRM companion overlay: 3D avatar runtime, emote system, and companion app views for Eliza agents.

## Purpose / role

Adds a 3D VRM avatar companion surface to an Eliza agent. It registers the `PLAY_EMOTE` action so agents can trigger one-shot avatar animations, and exposes three registered views (standard, XR, and TUI) that host the Three.js VRM scene. The plugin is **opt-in** — it only activates when the agent session is for the companion hosted app (gated via `gatePluginSessionForHostedApp`). Load it by including the package in the agent's plugin list.

## Plugin surface

### Actions
- **`PLAY_EMOTE`** (`src/actions/emote.ts`) — Posts to `/api/emote` to play a one-shot named animation on the active VRM avatar. Validates via `runtime.character.settings?.DISABLE_EMOTES` and requires `message.content.source === "client_chat"`. Enum of valid emote IDs is derived from `AGENT_EMOTE_CATALOG`.

### Views (registered in `src/plugin.ts`)
- **`companion`** (standard) — `CompanionView` component; path `/companion`.
- **`companion`** (xr) — `CompanionView` component; `viewType: "xr"`.
- **`companion`** (tui) — `CompanionTuiView` component; path `/companion/tui`, `viewType: "tui"`.

### Overlay app
- `registerCompanionApp()` (`src/register.ts` / `src/components/companion/companion-app.ts`) — registers the companion as a named overlay app in `@elizaos/ui`'s `OverlayApp` registry. Called automatically on module import of `src/register.ts`.

## Layout

```
src/
  plugin.ts                  Plugin definition (PLAY_EMOTE action + 3 views); export: appCompanionPlugin
  register.ts                Side-effect entry: calls registerCompanionApp() on import
  register-terminal-view.tsx Side-effect entry: registers the terminal/TUI view
  ui.ts                      Re-exports all UI/component public surface
  index.ts                   Full public API re-export barrel
  character-catalog.ts       Re-exports character asset helpers from @elizaos/ui
  vrm-assets.ts              VRM asset URL helpers (getVrmUrl, getVrmPreviewUrl, etc.)

  types/
    render-modes.ts          Render mode type definitions

  actions/
    emote.ts                 PLAY_EMOTE action implementation

  emotes/
    catalog.ts               EMOTE_CATALOG, AGENT_EMOTE_CATALOG, EmoteDef type, getEmote, getEmotesByCategory
    index.ts                 Re-export barrel

  components/
    avatar/
      VrmEngine.ts           Core Three.js + @pixiv/three-vrm scene engine (loads VRM, runs animation loop)
      VrmViewer.tsx          React wrapper around VrmEngine
      VrmAnimationLoader.ts  Loads GLB/FBX emote clips; handles gzip (.gz) assets
      VrmBlinkController.ts  Automated eye blink behaviour
      VrmCameraManager.ts    Camera positioning and look-at logic
      SceneOverlayManager.ts Manages in-scene overlays (chat bubbles, agent status, triggers)
      scene-overlay-renderer.ts  AgentStatusOverlay / ChatOverlayMessage / TriggerOverlay types + rendering
      retargetMixamoFbxToVrm.ts  Mixamo FBX → VRM bone retargeting
      retargetMixamoGltfToVrm.ts Mixamo glTF → VRM bone retargeting
      mixamoVRMRigMap.ts     Bone name mapping table
      VrmFootShadow.ts       Ground shadow plane
      VrmTeleportEffect.ts   Sparkle teleport particle effect
      MathEnvironment.ts     Math utilities for scene calculations
      scene-theme-tokens.ts  Light/dark theme color tokens for scene materials
      vrm-desktop-energy.ts  Desktop energy / idle animation management
      vector-browser-three.ts   Browser-compatible Three.js vector helpers
      vector-browser-utils.ts   General browser utility helpers for the scene

    companion/
      CompanionView.tsx      Main overlay view (avatar + chat + emote picker + settings)
      CompanionView.helpers.ts   Helper utilities for CompanionView
      CompanionView.interact.ts  Interaction logic for CompanionView
      CompanionAppView.tsx   Outermost app wrapper loaded by the overlay app registry
      CompanionShell.tsx     Shell with tab management and VRM prefetch gate
      CompanionSceneHost.tsx VrmStage host: wires zoom, pointer events, prefetch, scene context
      CompanionSpatialView.tsx   Spatial/XR companion view
      CompanionStageBackdrop.tsx Stage backdrop component
      CompanionHeader.tsx    Top bar with view tab switcher
      CompanionSettingsPanel.tsx  Settings panel (avatar selection, performance toggles)
      CompanionPerformanceSettings.tsx  VRM power / framerate / animate-when-hidden toggles
      EmotePicker.tsx        UI grid of triggerable emotes (AGENT_EMOTE_CATALOG)
      emote-picker-grid.ts   Emote picker grid layout logic
      GlobalEmoteOverlay.tsx Full-screen emote trigger overlay
      InferenceCloudAlertButton.tsx  Alert button when cloud inference is unavailable
      VrmStage.tsx           Three.js canvas mount and VrmEngine lifecycle
      companion-view-bundle.ts   View bundle entry point / exports for Vite build
      scene-overlay-bridge.ts  SceneOverlayDataBridge React component — syncs app state into SceneOverlayManager
      companion-app.ts       companionApp OverlayApp definition + registerCompanionApp()
      companion-scene-status-context.ts  React context for scene load/ready status
      shared-companion-scene-context.ts  Shared context between CompanionSceneHost and children
      resolve-companion-inference-notice.ts  Derives cloud-inference alert state from app config
      companion-shell-styles.ts  COMPANION_OVERLAY_TABS constant + CSS helpers
      shell-control-styles.ts   Control button CSS
      walletUtils.ts         Wallet display helpers used in companion header

    chat/
      ChatAvatar.tsx         Small avatar thumbnail for chat message rows
```

## Commands

```bash
bun run --cwd plugins/plugin-companion typecheck
bun run --cwd plugins/plugin-companion lint
bun run --cwd plugins/plugin-companion test
bun run --cwd plugins/plugin-companion build
bun run --cwd plugins/plugin-companion build:js      # tsup — runtime JS bundle
bun run --cwd plugins/plugin-companion build:views   # Vite — companion view bundle (dist/views/)
bun run --cwd plugins/plugin-companion build:types   # tsc declarations
bun run --cwd plugins/plugin-companion clean
bun run --cwd plugins/plugin-companion storybook     # Storybook dev on :6007
```

## Config / env vars

| Name | Required | Default | Where used |
|------|----------|---------|------------|
| `API_PORT` | No | `2138` | `emote.ts` — port for `POST /api/emote` |
| `SERVER_PORT` | No | `2138` | `emote.ts` — fallback if `API_PORT` unset |
| `character.settings.DISABLE_EMOTES` | No | unset | `emote.ts` validate — set to any truthy value in character config to disable `PLAY_EMOTE` |

## How to extend

### Add an emote

1. Add an `EmoteDef` entry to `RAW_EMOTE_CATALOG` in `src/emotes/catalog.ts`. Set `path` to the animation file served from the static bundle (`.glb` or `.fbx`; the catalog automatically appends `.gz`).
2. The new ID is automatically available in `AGENT_EMOTE_CATALOG` (and thus in `PLAY_EMOTE`'s `enum`) unless you add it to `AGENT_EMOTE_EXCLUDED_IDS`.

### Add a new action

1. Create `src/actions/<name>.ts` implementing `Action` from `@elizaos/core`.
2. Import and add it to the `actions` array in `src/plugin.ts`.
3. Export it from `src/index.ts` if it needs to be part of the public API.

### Add a new view

1. Create the React component under `src/components/companion/`.
2. Export it from `src/ui.ts`.
3. Add a view registration entry to the `views` array in `src/plugin.ts` with a unique `id`, `path`, `bundlePath`, and `componentExport` matching the export name in the Vite views bundle.

### Add a provider or service

The current plugin registers no providers, evaluators, or services beyond the `PLAY_EMOTE` action. To add one, import and include it in the `rawCompanionPlugin` object in `src/plugin.ts` using the standard `@elizaos/core` `Plugin` fields (`providers`, `services`, `evaluators`).

## Conventions / gotchas

- **Session gating.** `appCompanionPlugin` is wrapped by `gatePluginSessionForHostedApp(rawCompanionPlugin, "@elizaos/plugin-companion")`. Actions and views only run when the agent session is scoped to this hosted app. Do not remove the gate.
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views build are separate. The views bundle (`dist/views/bundle.js`) is what the `bundlePath` in each view registration points to. Both must be run for a complete build.
- **Peer dependencies.** `three`, `@pixiv/three-vrm`, `react`, and `react-dom` are peer deps — they must be present in the host application. Do not import them as direct deps.
- **Animation assets are gzip-compressed.** `VrmAnimationLoader` expects `.glb.gz` and `.fbx.gz` paths. `gzipAnimationPath()` in the catalog appends `.gz` automatically — do not double-suffix.
- **`__ELIZA_VRM_ENGINES__`** is a debug global on `window` that `scene-overlay-bridge.ts` uses to locate the active `VrmEngine` instance at runtime. Do not remove this registration from `VrmViewer`.
- **Emote HTTP call is fire-and-forget.** `PLAY_EMOTE` returns success/failure but does not await animation completion. The 2 500 ms `AbortController` timeout prevents indefinite hangs when the dashboard server is unreachable.
- **Storybook** dev requires the Three.js and VRM peer deps. Run `bun run --cwd plugins/plugin-companion storybook` from within the plugin directory.
- See the root `AGENTS.md` for repo-wide architecture rules, naming conventions, logger requirements, and ESM/module standards.

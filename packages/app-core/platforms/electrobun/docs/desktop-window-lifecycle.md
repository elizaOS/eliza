# Desktop window & lifecycle model (Electrobun)

The intended desktop experience — and the window/tray/deep-link machinery that
implements it. Companion to `startup-first-run-cleanup.md` (boot sequence) and
`../../../../docs/electrobun-startup.md` (child-process spawn + health polling).

Issue #10720.

## The experience in one paragraph

On launch the desktop app opens **chat first** — a chromeless, transparent,
always-on-top bottom bar rendering only the floating chat overlay, **not** the
full dashboard window. On macOS the app is **dockless by default** (#12184): the
pill + menu-bar icon are the resting surface and there is **no Dock icon** until
a full window opens. The pill passes clicks through its transparent regions
(`passthrough`), joins every Space (`setVisibleOnAllWorkspaces`), and re-anchors
to the primary display's work area when displays change. Onboarding runs
**conversationally inside that chat** (pick where the agent runs → optional
Cloud login → provider → tutorial), never a separate setup window. The full app
is always one gesture away (tray popover launcher, tray/menu-bar "Views", deep
link, or dock click), each of which opens the requested surface in its own
window — and opening one reveals the Dock icon. This matches assistants like
Claude Desktop / Wispr Flow: a resting chat surface, the rest of the app
summoned on demand.

## Launch: chat-first is the default

| Concern | Function | Default |
| --- | --- | --- |
| Bottom-bar (chat-overlay) shell is the resting surface | `shouldStartBottomBar()` (`desktop-bottom-bar-config.ts`) | **ON** (#10350); opt out with `ELIZA_DESKTOP_BOTTOM_BAR=0` |
| Window presentation (frameless / transparent / titleBarStyle) | `resolveDesktopShellWindowPresentation()` | `bottom-bar` unless kiosk |
| Renderer told to render the overlay shell | `appendChatOverlayShellModeParam()` → `?shellMode=chat-overlay` | appended in `createMainWindow()` (`index.ts`) |
| Bar geometry (anchored to work-area bottom edge) | `computeBottomBarFrame()` | 140px tall, full width |
| Kiosk (fullscreen, exclusive) | `isKioskShellMode()` | opt-in; wins over bottom-bar |

The renderer's `ChatOverlayShell` (`packages/ui/src/App.tsx`) renders just the
`HomePill` + `ContinuousChatOverlay` over a transparent background when
`shellMode === "chat-overlay"`. No full-app tab system is mounted in this mode;
"show a view" intents open a dedicated window instead (see **Summoning views**).
Escape collapses the overlay first, then (when already collapsed) hides the
window; the global summon hotkey **toggles** the pill (focused+visible →
hide, else show+focus) via the pure `decideChatOverlayToggle()`
(`packages/app/src/desktop-hotkey.ts`).

## Onboarding: in-chat, not a separate window

First-run is driven by `use-first-run-conductor.ts` (`packages/ui/src/first-run/`),
a headless conductor that seeds synthetic assistant turns into the **same chat
transcript** the UI already renders: greeting → runtime choice (cloud / local /
other) → optional Cloud OAuth → provider choice → tutorial choice. It owns no
presentation; `InlineWidgetText` / `SensitiveRequestBlock` renderers draw the
widgets from message fields.

`App.tsx` paints the live chat shell during the `first-run-required` phase
(`isShellPaintable === true`) so onboarding runs *in* the chat. Only the truly
pre-shell phases (session restore, backend polling, device pairing, fatal error)
show the full-screen `StartupScreen`. There is **no** standalone onboarding
window or route on the default path.

## Summoning views (tray / menu / deep link)

The bottom-bar shell has no inline tabs, so every "open X" intent opens a
dedicated window:

- **Tray menu** (`tray-menu.ts` + `DesktopTrayRuntime`): fixed surfaces plus a
  generated "Views" section (one entry per internal tool view); `tray-app-<slug>`
  opens the view in its own window via `openDesktopAppWindow` (#10716).
- **Menu bar** (`application-menu.ts`): `buildViewsMenu()` lists the same catalog
  as `apps:<slug>`, routed through `handleAppEntryMenuAction` (`index.ts`);
  `new-window:<surface>` opens detached surfaces once the agent is ready.
- **Deep links** (`desktop-deep-link-events.ts`): `classifyDeepLinkRoute()` is a
  pure, unit-tested router (#10770). `elizaos://apps/<slug>` (host compared
  case-insensitively — custom schemes don't lowercase the host) opens the app
  window; anything else forwards to the renderer's `handleDeepLink`.
- **Global hotkey** (`main.tsx` + `desktop-hotkey.ts`): a programmable
  accelerator fronts the floating chat (`show + focus`) even when backgrounded
  (#10716).

## Tray, focus/restore, single-instance

| Concern | Where | Behavior |
| --- | --- | --- |
| Tray created | `shouldCreateDesktopTray()` | ON by default; opt out `ELIZA_DESKTOP_DISABLE_TRAY=1` |
| Dockless (tray-first): pill at boot, Dock icon hidden at rest | `shouldStartTrayFirst()` | macOS **default ON** (#12184); kill switch `ELIZA_DESKTOP_TRAY_FIRST=0`. The pill window is still created at boot — it just isn't a "full window" for the Dock. |
| Dock icon tracking | `DesktopManager.syncTrayFirstDock()` | Dock visible iff ≥1 full/managed window (dashboard/surface/settings/app) — driven by `setMainWindowFullWindow()` + `setManagedWindowsPresent()` (wired to `SurfaceWindowManager.onRegistryChanged`). The pill never counts. |
| Tray popover (launcher + widget surface anchored at the tray icon) | `shouldEnableTrayPopover()` | macOS opt-in `ELIZA_DESKTOP_TRAY_POPOVER=1`; anchors under the real `Tray.getBounds()`, reuses one window across toggles, dismisses on blur (200ms tray-click guard). Hosts the `TrayLauncher` rows above the widget stack. |
| Restore / create-if-missing / focus | `restoreWindow()` (`index.ts`) | unminimize + focus, or create the main window and attach RPC |
| Show a surface + focus | `showMainSurface()` | `restoreWindow()` then `showWindow()` + tray-menu event to renderer |
| Tray-icon click | `DesktopManager.trayClickHandler` | toggles the popover if configured, else `show + focus` (summon parity with the hotkey) |
| Dock click (macOS reopen) | `setupDockReopen()` | `restoreWindow()` |
| Single instance | Electrobun native | second launch is routed to the running instance; deep links arrive via `shareTargetReceived` |

## Environment knobs

`ELIZA_DESKTOP_BOTTOM_BAR` · `ELIZA_DESKTOP_DISABLE_TRAY` / `ELIZA_DESKTOP_TRAY`
· `ELIZA_DESKTOP_TRAY_FIRST` (macOS dockless; **default ON**, set `=0` to keep
the Dock icon at rest) · `ELIZA_DESKTOP_TRAY_POPOVER` · kiosk shell mode. All
default to the chat-first, dockless-on-macOS, tray-enabled experience above.

## Contract tests

`desktop-experience-contract.test.ts` pins the defaults this doc promises
(chat-first bottom bar ON, `?shellMode=chat-overlay` appended, tray ON,
dockless/tray-first ON for macOS with a `=0` kill switch, popover opt-in, kiosk
overrides). `desktop-deep-link-events.test.ts`
covers the deep-link router. Full-shell e2e that drives the real Electrobun
window via the `/api/dev/*` loopback (`dev/stack`, `dev/cursor-screenshot`,
`dev/console-log`) requires a built desktop app and is captured by a human per
`PR_EVIDENCE.md`.

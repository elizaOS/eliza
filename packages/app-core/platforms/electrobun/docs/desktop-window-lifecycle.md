# Desktop window & lifecycle model (Electrobun)

The intended desktop experience — and the window/tray/deep-link machinery that
implements it. Companion to `startup-first-run-cleanup.md` (boot sequence) and
`../../../../docs/electrobun-startup.md` (child-process spawn + health polling).

Issue #10720.

## The experience in one paragraph

On launch the desktop app opens the normal full application window with Dock
presence. Appliance builds can explicitly opt into the chromeless,
always-on-top chat bar and dockless menu-bar behavior. That accessory window
joins every Space (`setVisibleOnAllWorkspaces`) and re-anchors when displays
change, while the full application remains an ordinary opaque macOS window.

## Launch: full application is the default

| Concern | Function | Default |
| --- | --- | --- |
| Bottom-bar (chat-overlay) shell | `shouldStartBottomBar()` (`desktop-bottom-bar-config.ts`) | **OFF**; appliance builds opt in with `ELIZA_DESKTOP_BOTTOM_BAR=1` |
| Window presentation (frameless / transparent / titleBarStyle) | `resolveDesktopShellWindowPresentation()` | normal opaque application unless bottom-bar or kiosk is explicitly selected |
| Renderer told to render the overlay shell | `appendChatOverlayShellModeParam()` → `?shellMode=chat-overlay` | appended in `createMainWindow()` (`index.ts`) |
| Bar geometry (anchored to work-area bottom edge) | `computeBottomBarFrame()` | 140px tall, full width |
| Kiosk (fullscreen, exclusive) | `isKioskShellMode()` | opt-in; wins over bottom-bar |

The renderer's `ChatOverlayShell` (`packages/ui/src/App.tsx`) renders just the
`HomePill` + `ChatOverlay` over a transparent background when
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
  generated "Windows" section (one entry per internal tool view); `tray-app-<slug>`
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
| Dockless (tray-first): pill at boot, Dock icon hidden at rest | `shouldStartTrayFirst()` | macOS **default OFF**; accessory builds opt in with `ELIZA_DESKTOP_TRAY_FIRST=1`. |
| Dock icon tracking | `DesktopManager.syncTrayFirstDock()` | Dock visible iff ≥1 full/managed window (dashboard/surface/settings/app) — driven by `setMainWindowFullWindow()` + `setManagedWindowsPresent()` (wired to `SurfaceWindowManager.onRegistryChanged`). The pill never counts. |
| Native tray menu | `shouldAttachTrayMenu()` | ON by default on macOS, Windows, and Linux. The native menu contains a **Windows** submenu plus **Quit**, so process exit works before the renderer bridge is ready. Emergency opt-out: `ELIZA_DESKTOP_TRAY_MENU=0`. |
| Experimental renderer tray popover | `shouldEnableTrayPopover()` | OFF by default. Opt in with `ELIZA_DESKTOP_TRAY_POPOVER=1` together with `ELIZA_DESKTOP_TRAY_MENU=0`; it anchors under `Tray.getBounds()` and reuses one renderer window. |
| Restore / create-if-missing / focus | `restoreWindow()` (`index.ts`) | unminimize + focus, or create the main window and attach RPC |
| Show a surface + focus | `showMainSurface()` | `restoreWindow()` then `showWindow()` + tray-menu event to renderer |
| Tray-icon click | native `Tray.setMenu()` | opens the OS-native dropdown; the white handle and global shortcut summon chat directly |
| Dock click (macOS reopen) | `setupDockReopen()` | `restoreWindow()` |
| Single instance | Electrobun native | second launch is routed to the running instance; deep links arrive via `shareTargetReceived` |

## Environment knobs

`ELIZA_DESKTOP_BOTTOM_BAR` (optional accessory shell; **default OFF**) ·
`ELIZA_DESKTOP_DISABLE_TRAY` / `ELIZA_DESKTOP_TRAY` ·
`ELIZA_DESKTOP_TRAY_FIRST` (macOS dockless; **default OFF**, opt in with `=1`) ·
`ELIZA_DESKTOP_TRAY_MENU` (native taskbar/menu-bar
dropdown; **default ON**) · `ELIZA_DESKTOP_TRAY_POPOVER` (experimental macOS
renderer launcher; **default OFF**, opt in with `=1`) · kiosk shell
mode. The normal application window, Dock presence, and native tray menu are the
default experience.

## Phase 2 fork capabilities and the version-bump path (#12184)

The remaining pill/tray gaps need native changes that live in the Electrobun
fork (`upstreams/electrobun`, github.com/elizaOS/electrobun), not in this
package. They are implemented on the fork branch
`feat/12184-panel-hotkeys-win-tray` and reach the app **only through a
published `electrobun` version bump** — never via `patches/` (that mechanism is
reserved for the small CLI patch) and never by editing `node_modules`.

What the fork adds:

- **macOS non-activating panels (G1):** a window created with
  `styleMask: { NonactivatingPanel: true }` is now an `ElectrobunPanel :
  NSPanel` — floating level, joins all Spaces, shows over full-screen apps,
  takes key status for typing **without activating the app** (the
  previously-active app keeps menu-bar ownership; the Wispr/Raycast behavior).
- **`getWindowStyle` FFI fix (prerequisite for G1):** the style flags now cross
  the FFI as a single packed `u32` instead of 12 separate `bool` args. Bun's
  arm64 FFI drops bool arguments past the register slots (positions 9-12), which
  had silently forced `NonactivatingPanel`/`DocModalWindow`/`HUDWindow` to
  `false` — so the panel mask never reached native until this fix.
- **macOS global hotkeys via Carbon `RegisterEventHotKey` (G2):** registration
  no longer needs Accessibility permission, and a registered chord is
  **consumed** system-wide instead of also reaching the focused app. The
  accelerator grammar and `GlobalShortcut` API are unchanged.
- **Windows tray/flyout enablement (G3+G4, code-only until a Windows lane
  verifies it):** `Tray.getBounds()` returns the real icon rect
  (`Shell_NotifyIconGetRect`); `styleMask.NonactivatingPanel` maps to
  `WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW + WS_EX_TOPMOST` (no focus steal, no
  taskbar button) and `styleMask.UtilityWindow` to `WS_EX_TOOLWINDOW`.

Integration sequence when cutting the bump (the consumed npm `electrobun@1.18.1`
predates the fork's Rust port, so this is a coordinated upgrade):

1. Merge the fork branch into fork `develop`, tag (`v1.18.5-beta.x`+), and
   publish from `upstreams/electrobun/package` (`bun npm:publish:beta`).
2. Bump the `electrobun` dependency in this package's `package.json` and
   rebase `patches/electrobun@<version>.patch` (CLI patch) onto the new
   version; `bun install` to refresh `bun.lock`.
3. Flip the pill and tray popover to `styleMask: { NonactivatingPanel: true }`
   on darwin in `createMainWindow()` / the popover creation path, and re-run
   `desktop-experience-contract.test.ts` + per-OS captures. Until that bump,
   the app keeps the 1.18.1 behavior (activating summon; listen-only macOS
   hotkey that needs Accessibility trust).

## Contract tests

`desktop-experience-contract.test.ts` pins the defaults this doc promises
(chat-first bottom bar ON, `?shellMode=chat-overlay` appended, tray ON,
dockless/tray-first and launcher popover ON for macOS with `=0` kill switches,
and kiosk overrides). `desktop-deep-link-events.test.ts`
covers the deep-link router. Full-shell e2e that drives the real Electrobun
window via the `/api/dev/*` loopback (`dev/stack`, `dev/cursor-screenshot`,
`dev/console-log`) requires a built desktop app and is captured by a human per
`AGENTS.md`.

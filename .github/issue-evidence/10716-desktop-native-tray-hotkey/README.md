# Evidence — #10716 native tray/menu view-opening + programmable global hotkey floating chat

Branch: `feat/10716-desktop-native-tray-hotkey`

## What shipped

| Acceptance criterion | Implementation | Proof |
| --- | --- | --- |
| Tray opens a view in its **own window** (chat + ≥2 non-default views) | `tray-menu.ts` generates a "Views" section from the shared internal-tool-app catalog (`getInternalToolAppDescriptors`); `DesktopTrayRuntime` opens each `tray-app-<slug>` via `openDesktopAppWindow` | `tray-menu.test.ts` (8) |
| Menu bar **"Views"** submenu opens each view in its own window | `application-menu.ts` — `buildViewsMenu()` (renamed from Apps) → `apps:<slug>` → existing `handleAppEntryMenuAction` own-window open | `application-menu.test.ts` (8, NEW suite the issue asked for) |
| Programmable global hotkey **fronts chat** even when backgrounded | `main.tsx` registers `summon-chat` (user accelerator ← `localStorage`, per-platform default) → on press `Desktop.showWindow()+focusWindow()` | `desktop-hotkey.test.ts` (31) |
| Default hotkey no longer collides with the command palette | Default is `⌘⇧Space` / `Ctrl+Shift+Space`, asserted `!== CommandOrControl+K` | `desktop-hotkey.test.ts` |
| Tray-icon click summons/fronts chat identically to the hotkey | `native/desktop.ts` `trayClickHandler` now `showWindow().then(focusWindow())` | code + review |
| Floating chat is the reused `chat-overlay` (no parallel renderer) | Summon show+focuses the existing bottom-bar/`ChatOverlayShell` window; no new window class | code (non-goal respected) |
| Programmable hotkey exposed in **Desktop settings** | `DesktopChatHotkeySetting` (record keystroke → validate safe-global → persist → re-register) rendered in `DesktopWorkspaceSection` | `DesktopChatHotkeySetting.test.tsx` (5) |
| `application-menu` / tray / `surface-windows` suites pass, extended with new tests | 52 new assertions across 3 packages | `unit-tests.log` |

## Tests — 52 new assertions, all green (`unit-tests.log`)

- `@elizaos/ui` `desktop-hotkey.test.ts` — 31 (accelerator normalize/validate, safe-global gate, per-platform default, keystroke capture, display formatting, localStorage load/save, resolve).
- `@elizaos/ui` `DesktopChatHotkeySetting.test.tsx` — 5 (render, record+persist, reject unsafe, Escape cancel, reset-to-default).
- `@elizaos/electrobun` `application-menu.test.ts` — 8 (NEW; Views submenu, Summon Chat click path w/o local accelerator, agent-ready gating, browser gating, entry resolution).
- `@elizaos/app-core` `tray-menu.test.ts` — 8 (Views section generated from the launcher catalog, ordering, slug↔descriptor round-trip, splice position, quit-last).

Typecheck: clean for every changed file across `@elizaos/ui`, `@elizaos/app-core`,
`@elizaos/electrobun`, and `@elizaos/app` (`tsgo --noEmit`; the only worktree
errors are pre-existing generated-i18n stubs unrelated to this change).

## Real-LLM trajectory

**N/A** — desktop-shell window/hotkey wiring; no model/prompt/action path (per the
issue's own evidence section).

## Live native-shell capture (hotkey-when-backgrounded, cursor-screenshot)

**Deferred to a human on a built desktop app.** The summon-when-backgrounded flow
requires a global OS key event delivered to a running Electrobun build and an
OS-level screenshot — it cannot be driven from a headless/agent environment. To
capture from a freshly built desktop app (`reference_desktop_prod_build_launch`):

1. Build + launch the desktop app; open **Settings → Desktop Workspace**, set a
   custom "Summon chat hotkey" (e.g. `⌘⇧J`).
2. Background the app (focus another app), press the accelerator → the floating
   chat fronts. Capture `GET /api/dev/cursor-screenshot` before/after and
   `GET /api/dev/console-log` showing `desktopShortcutPressed { id: "summon-chat" }`.
3. Open the tray menu → click a "Views" entry → the view opens in its own window
   (`[main-window]` / `[DesktopManager]` logs).

The code paths these exercise are each covered by the unit suites above.

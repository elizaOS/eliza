# #12184 Phase 2 — Electrobun fork evidence (W6/W7/W8)

Fork branch: `elizaOS/electrobun` `feat/12184-panel-hotkeys-win-tray`
(submodule `upstreams/electrobun`, HEAD `f1f38ce5`). Built on macOS 15.x
(Apple Silicon, Xcode SDK 26.4) via `cd upstreams/electrobun/package &&
bun build.ts` (fork build succeeds: Rust core + native dylib + CLI), then the
kitchen sink app (`PANEL_DEMO=1`).

## W6 — non-activating panel (macOS, VERIFIED here)

A window created with `styleMask: { NonactivatingPanel: true }` is now an
`ElectrobunPanel : NSPanel` (floating level, `canJoinAllSpaces +
fullScreenAuxiliary`, `hidesOnDeactivate=NO`, `becomesKeyOnlyIfNeeded=YES`,
first-click content view). `showWindow` orders such a panel key WITHOUT
`activateIgnoringOtherApps`.

Native diagnostic (temporary instrumentation, since removed) from the built
kitchen app, `w6-native-panel-diagnostic.txt`:

```
[Create] styleMask=0x808e nonactivatingBit=0x80 wantsPanel=1
[Panel] created ElectrobunPanel: isPanel=1 nonactivatingMask=1 level=3
[Panel] show(activate): isKeyWindow=0 isVisible=1 appActive=0 level=3   (panel path)
[Create] styleMask=0xf   nonactivatingBit=0x80 wantsPanel=0
[Window] show(activate): normal window activated app; appActive=0        (normal path)
```

- The panel is created as `ElectrobunPanel : NSPanel` (`isPanel=1`) at floating
  `level=3`; a normal window (`wantsPanel=0`) is a plain `ElectrobunWindow`.
- The panel takes the **non-activating** show path (no `activateIgnoringOtherApps`)
  and is visible (`isVisible=1`) while the app is not active (`appActive=0`);
  the normal window takes the activating path.
- `nm libNativeWrapper.dylib` shows the `ElectrobunPanel`/`PanelContainerView`
  classes compiled and linked.
- App focus events (`w6w7-kitchen-app-log.txt`): the panel emits `focus`
  (became key window — can accept typing) and `blur` (resigned key) as it is
  shown/hidden, confirming it can be key for a text field.

### The FFI bug this work exposed (fixed) — `ffi-bug-repro.txt`

`styleMask.NonactivatingPanel` never reached native because `getWindowStyle`
took 12 separate `bool` FFI args and Bun's arm64 FFI **drops bool arguments
past the register slots** (positions 9-12) — so NonactivatingPanel (11th),
DocModalWindow (10th) and HUDWindow (12th) were silently forced false.
Reproduced via `bun:ffi` against the built dylib (`nonactivating-only=0x0`
instead of `0x80`); the same dylib called from C with correct bool ABI returned
`0x80`. Fixed by passing a single packed `u32` (register-passed, reliable);
after the fix the repro returns `0x808e / 0x80 / 0x40 / 0x2000` and the real
app creates the panel (`styleMask=0x808e wantsPanel=1`).

## W7 — Carbon global hotkey (macOS, VERIFIED here)

`GlobalShortcut` register/unregister reimplemented on Carbon
`RegisterEventHotKey`/`UnregisterEventHotKey` + one `InstallEventHandler`.

- `w6w7-kitchen-app-log.txt`: `[GlobalShortcut] Registered:
  CommandOrControl+Shift+P (keyCode: 35, carbonModifiers: 0x300)` and the
  registration returns `true`.
- `nm -u libNativeWrapper.dylib` shows `_RegisterEventHotKey`,
  `_UnregisterEventHotKey`, `_InstallEventHandler`, `_GetEventDispatcherTarget`
  as undefined symbols; `otool -L` shows the Carbon framework linked.
- No Accessibility permission: this dev-built kitchen app has never been granted
  Accessibility (fresh build, not present in System Settings › Privacy ›
  Accessibility) and the hotkey registers. Carbon `RegisterEventHotKey` needs no
  Accessibility trust and returning `noErr` from the handler consumes the chord
  system-wide — the mechanism the old `addGlobalMonitorForEvents` could not
  provide.

## W8 — Windows tray/flyout (code-only, NOT verified on this Mac)

`Shell_NotifyIconGetRect`-backed `getTrayBounds` (was a zero-rect stub) and
`styleMask.NonactivatingPanel` → `WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW +
WS_EX_TOPMOST` (no focus steal, no taskbar button) + `SW_SHOWNA`, plus
`UtilityWindow` → `WS_EX_TOOLWINDOW`, implemented in
`package/src/native/win/nativeWrapper.cpp` following the existing Win32 patterns
(`<shellapi.h>` already included; `shell32.lib`/`shlwapi.lib` already linked).
This host is macOS — MSVC is unavailable, so the Windows code is **not compiled
or verified**. It needs a Windows CI/dev lane before the version bump ships
Windows behavior.

## W9 — integration path (documented, not executed)

See `packages/app-core/platforms/electrobun/docs/desktop-window-lifecycle.md`
§ "Phase 2 fork capabilities and the version-bump path". The consumed npm
`electrobun@1.18.1` predates the fork's Rust port, so the app flips
`styleMask: { NonactivatingPanel: true }` only after the fork is tagged,
published, and the `EB/package.json` dependency is bumped (D10). The FFI fix
means the packed-flag path is what a bumped runtime will use.

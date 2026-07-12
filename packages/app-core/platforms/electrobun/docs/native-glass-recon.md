# Native window glass (vibrancy / Mica / blur-behind) — recon

How the desktop chat-overlay window can put a **real OS glass material** behind
its transparent webview so the renderer's CSS glass refracts the actual
desktop, per platform. macOS is implemented (opt-in flag, see below); Windows
and Linux are recon-only — this host cannot exercise them.

The layered-glass architecture:

```
[desktop wallpaper / other apps]
  → [OS blur material: NSVisualEffectView | Mica/Acrylic | KWin blur region]
    → [transparent webview (WKWebView / CEF)]
      → [renderer CSS glass (backdrop-filter over transparency)]
```

## What Electrobun (1.18.1) exposes today

`BrowserWindow` constructor options (`electrobun/dist/api/bun/core/BrowserWindow.ts`,
`WindowOptionsType`):

```ts
// titleBarStyle options:
// - 'default': normal titlebar with native window controls
// - 'hidden': no titlebar, no native window controls (for fully custom chrome)
// - 'hiddenInset': transparent titlebar with inset native controls
titleBarStyle: "hidden" | "hiddenInset" | "default";
// transparent: when true, window background is transparent (see-through)
transparent: boolean;
// passthrough: when true, mouse events pass through transparent regions
passthrough: boolean;
```

`BrowserView` adds `startTransparent` / `startPassthrough` (pre-first-paint
view transparency); `GpuWindow` has its own `transparent: boolean`. There is
**no** `vibrancy`, `material`, `backgroundColor`, `backgroundMaterial`, or
blur-related option anywhere in the published API — a repo-wide grep of
`node_modules/electrobun/dist` for `vibrancy|material|visualeffect|acrylic|mica`
matches only the unrelated window `blur` focus event.

So Electrobun gives us a transparent hole in the window; the glass material
must come from somewhere else.

## macOS — implemented (opt-in)

This platform already ships its own native dylib
(`native/macos/window-effects.mm` → `src/libMacWindowEffects.dylib`, built by
`scripts/build-macos-effects.sh`, loaded via Bun FFI in
`src/native/mac-window-effects.ts`). It exports:

```c
extern "C" bool enableWindowVibrancy(void *windowPtr);
```

which makes the NSWindow non-opaque with a clear background and installs a
genuine `NSVisualEffectView` (identifier `ElectrobunVibrancyView`, material
`NSVisualEffectMaterialUnderWindowBackground` on ≥10.14 else `Sidebar`,
blending `NSVisualEffectBlendingModeBehindWindow`, state `Active`) **below the
WKWebView** in the content view. Electrobun exposes the raw `NSWindow*` as
`BrowserWindow.ptr`, which is what makes this possible without forking
Electrobun.

Wiring (this change): the chat-overlay (bottom-bar) window opts in via
`ELIZA_DESKTOP_NATIVE_GLASS=1` (default **OFF**) —
`shouldEnableNativeGlass()` in `src/desktop-bottom-bar-config.ts`, applied in
`applyMacOSWindowEffects(win, { nativeGlass })` in `src/index.ts`. Default is
off because the effect view is full-window: it frosts the entire bar frame,
including the empty region beside the pill, which #12184 rejected as the
resting look. `vibrancyEnabled` in the main-window runtime snapshot
(`src/main-window-runtime.ts`) reports the actual native result.

Known limitations to solve before default-ON:

- **No region clipping.** The vibrancy view is full-window. Making the glass
  pill-shaped needs either a mask layer on the `NSVisualEffectView`
  (`maskImage` / `layer.mask` sized to the pill rect, updated from the
  renderer) or a separate small vibrancy child window under the pill.
- **Window drag on the frosted region.** `enableWindowVibrancy` sets
  `movableByWindowBackground:YES`, so with the flag on, a drag on the frosted
  empty region beside the pill moves the anchored bottom-bar window (the 5s
  reanchor poll snaps it back). Skip `setMovableByWindowBackground` for the
  bottom-bar window when promoting this past opt-in.
- **Click-through is unverified over the effect view.** The bar relies on OS
  click-through over transparent regions (the `passthrough` window option);
  whether clicks beside the pill still pass through with a full-window
  `NSVisualEffectView` installed depends on Electrobun's native hit-testing in
  the zig binary — verify on-device before default-ON.

## Native transcript spike — macOS (proved)

Can the serialized transcript frame (`eliza.native-transcript/v1`,
`packages/ui/src/chat/native-transcript/spec.ts`) render in REAL native macOS
UI over the Electrobun window, on the same contract the mobile renderers use?
**Yes — proved end to end on this host (macOS 26.2).**

What exists:

- `native/macos/transcript-view.mm` → `src/libMacTranscriptView.dylib`
  (built by `scripts/build-macos-transcript.sh`, `bun run
  build:native-transcript` — same clang invocation as the effects dylib).
  FFI surface: `transcriptShow(nsWindow, frameJson, x, y, w, h)`,
  `transcriptSetTranscript(nsWindow, frameJson)`, `transcriptHide(nsWindow)`,
  `transcriptTakePendingAction()` (malloc'd string or NULL) +
  `transcriptFreeCString`. Actions are **poll-drained**, matching the dylib
  layer's existing native→JS convention (`elizaOnboardingGetChoice`) — no
  C-callback channel, and never a second action protocol: a tap enqueues the
  exact string the DOM widget would pass to `sendActionMessage`.
- `src/native/mac-transcript.ts` — Bun FFI wrapper mirroring
  `mac-window-effects.ts` (native-library policy + `assertDlopenPathAllowed`),
  gated **default OFF** behind `ELIZA_DESKTOP_NATIVE_TRANSCRIPT=1`
  (`shouldEnableNativeTranscript`, unit-tested in `mac-transcript.test.ts`).
- Renderer scope (spike): decodes the committed golden fixture tolerantly and
  draws text turns (user right-aligned dark chips / assistant left
  full-width, markdown-ish via Foundation's inline-markdown parser), fenced
  code blocks (monospaced, lang tag), reasoning + tool-event + failure +
  turn-status side channels, interactive **choice** chips and
  **permission-card** Grant/fallback buttons (documented action strings),
  `reply` followup chips, and labeled placeholder cards for
  form/workflow/checklist/task/background/ui-spec/config. Transparent list
  background — the NSVisualEffectView glass below shows through. Orange
  `#ff7a3d` accent only.

Evidence (`native/macos/spike-evidence/`, produced by
`transcript-spike-harness.mm` — a standalone `main()` that opens a dark
vibrancy NSWindow, feeds the golden fixture through the exact extern "C"
surface, clicks a rendered choice chip, and drains the queue):

- `transcript-window-screencapture.png` / `…-top.png` — real WindowServer
  captures of the composited window over behind-window glass.
- `transcript-view-cachedisplay.png` — in-process full-height capture of the
  row stack (transparent background; the full-contentView cacheDisplay path
  renders blank because layer-backed chips + the vibrancy view don't
  composite through `cacheDisplayInRect`).
- Action round trip: clicking "Sign in to Eliza Cloud" enqueued
  `__first_run__:runtime:cloud` — byte-identical to the DOM widget's
  `sendActionMessage` payload.

Gaps before this graduates from spike:

- **Full widget parity** — form fields, workflow/checklist state rendering,
  task/background cards are placeholder rows; secret-request needs a real
  secure input (NSSecureTextField) before it can collect values.
- **Message-id diffing** — `transcriptSetTranscript` rebuilds the whole stack;
  the bridge contract says the native side diffs by message id.
- **Shell wiring** — nothing calls `mac-transcript.ts` yet; the renderer-side
  `NativeTranscript` Capacitor plugin surface
  (`packages/ui/src/glass/native-transcript-bridge.ts`) must be routed over
  the Electrobun RPC bridge to these FFI calls, and the poll loop feeds
  actions into the SAME `sendActionMessage` channel.
- **Scroll interop** — the native list owns its own NSScrollView; anchored
  overlay-rect sync with the DOM (keyboard, resize) is untested in-shell.
- Windows/Linux have no equivalent (no dylib, no AppKit); the recon sections
  below still describe the glass side only.

## What an upstream Electrobun change would look like

Concrete API proposal (mirrors Electron so migration knowledge transfers):

```ts
type WindowOptionsType = {
  // ...existing...
  // macOS: NSVisualEffectView material behind the webview
  vibrancy?: "under-window" | "sidebar" | "hud" | "popover" | "menu" | null;
  // Windows 11: DWM system backdrop
  backgroundMaterial?: "auto" | "none" | "mica" | "acrylic" | "tabbed";
  // All platforms: window background when not fully transparent
  backgroundColor?: string;
};
// plus runtime setters:
win.setVibrancy(material | null);
win.setBackgroundMaterial(material);
```

Implementation home is Electrobun's native layer (`launcher`/zig + objc/win32
shims) where the NSWindow/HWND are created; the Bun side only needs to thread
the option through `ffi.request.createWindow`.

## Windows — recon only (untestable on this macOS host)

- API: `DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &type, sizeof(type))`
  with `DWM_SYSTEMBACKDROP_TYPE` values `DWMSBT_MAINWINDOW` (Mica),
  `DWMSBT_TRANSIENTWINDOW` (Acrylic), `DWMSBT_TABBEDWINDOW` (Mica Alt),
  `DWMSBT_NONE`. Requires Windows 11 22H2+ (build 22621).
- The window's client area must be transparent where the backdrop should show
  (extend the frame via `DwmExtendFrameIntoClientArea` with `MARGINS{-1}` or a
  transparent WebView2/CEF layer).
- Older undocumented fallback: `SetWindowCompositionAttribute` with
  `ACCENT_ENABLE_ACRYLICBLURBEHIND` (Windows 10) — fragile, not recommended.
- Electrobun ships no Windows backdrop hook, and this repo's dylib equivalent
  does not exist for win32; this needs the upstream `backgroundMaterial`
  option or a small `SetWindowCompositionAttribute`/DWM shim DLL loaded by
  window HWND (Electrobun exposes `ptr` on Windows too, but the value is the
  native window handle wrapper — verify before assuming it is the raw HWND).

## Linux — recon only (untestable on this macOS host)

- **KDE / KWin (X11 + Wayland via KWin's own protocol):** set the
  `_KDE_NET_WM_BLUR_BEHIND_REGION` window property (XCB atom; cardinal list of
  x,y,w,h rects, empty list = whole window) — KWin blurs whatever is behind
  the listed region. On Wayland, the `org_kde_kwin_blur_manager` protocol does
  the same. KDE-only.
- **GNOME / Mutter:** **no protocol.** GNOME has no supported blur-behind API;
  third-party shell extensions ("Blur my Shell") patch it but cannot be relied
  on. A transparent window over the desktop simply shows the unblurred
  desktop.
- **wlroots compositors (Hyprland, sway+forks):** Hyprland has
  `decoration:blur` window rules keyed on window class — configuration on the
  compositor side, not an app API.
- Practical stance: Linux gets `transparent: true` at most, and the pill stays
  opaque there today (fork gap G4 in `desktop-bottom-bar-config.ts`).

## Honest platform support matrix

| Platform | OS material | API | Status here |
| --- | --- | --- | --- |
| macOS | NSVisualEffectView (behind-window) | own dylib `enableWindowVibrancy` via `BrowserWindow.ptr` | **Implemented**, opt-in `ELIZA_DESKTOP_NATIVE_GLASS=1`, needs pill-region masking before default-ON |
| Windows 11 22H2+ | Mica / Acrylic | `DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE, …)` | Recon only — no Electrobun option, no shim; needs upstream `backgroundMaterial` |
| Windows 10 | Acrylic (undocumented) | `SetWindowCompositionAttribute(ACCENT_ENABLE_ACRYLICBLURBEHIND)` | Not planned (fragile) |
| Linux KDE | KWin blur-behind | `_KDE_NET_WM_BLUR_BEHIND_REGION` / `org_kde_kwin_blur_manager` | Recon only |
| Linux GNOME | — | none (no protocol) | Impossible without shell extensions |
| Linux wlroots | compositor-side blur rules | Hyprland `decoration:blur` config | User-side config only |

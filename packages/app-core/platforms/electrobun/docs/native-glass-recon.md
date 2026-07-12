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

Known limitation to solve before default-ON: the vibrancy view has no region
clipping. Making the glass pill-shaped needs either a mask layer on the
`NSVisualEffectView` (`maskImage` / `layer.mask` sized to the pill rect,
updated from the renderer) or a separate small vibrancy child window under the
pill.

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

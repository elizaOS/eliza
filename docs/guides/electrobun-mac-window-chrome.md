---
title: Electrobun macOS window chrome
sidebarTitle: macOS window chrome
summary: Why the main window uses native drag/resize overlays above WKWebView, how depth scales per screen, and where each layer lives.
description: Architecture of Eliza’s macOS Electrobun frameless window — native strips vs CSS, cursor ownership, and contributor file map.
---

# Electrobun macOS window chrome

The **main** Eliza desktop window on macOS uses `titleBarStyle: "hiddenInset"`: traffic lights are inset, there is no classic title bar, and the **WKWebView** fills most of the client area. This guide explains **how** we make that window draggable and resizable, and **why** the solution is split across native code, Electrobun main-process TypeScript, and a small CSS file.

## The core problem

**WKWebView sits on top of the window’s `contentView`.** Anything drawn or tracked on the `contentView` *behind* the web view does not get normal mouse or cursor updates for the area covered by the page.

**WebKit owns the cursor** for pixels that belong to the web process. It applies DOM/CSS cursor styles (`pointer`, `text`, etc.) continuously. AppKit `NSTrackingArea` + `cursorUpdate:` on the `contentView` **under** the web view therefore:

- Rarely wins hit testing for the resize edges you care about.
- Fights WebKit when something tries to “reassert” `NSCursor` on a timer or on `mouseMoved` — users see **flicker**.

**`-webkit-app-region: drag`** is honored in Chromium-based shells. On **system** WKWebView it is **not** a reliable substitute for native dragging. We still ship CSS rules for **CEF** or future engines, but we do not depend on them for macOS WKWebView.

**Conclusion:** For predictable **move** and **resize** (cursor + drag), we need **native `NSView` overlays** that sit **above** the WKWebView in the z-order, with a clear contract for thickness and geometry.

## What we implement

### Top strip — window move

- **`ElectrobunNativeDragView`** (identifier `ElectrobunNativeDragView`) is a transparent view along the **top** of the `contentView`, inset from the left by `MAC_NATIVE_DRAG_REGION_X` so it clears the traffic lights.
- **`mouseDown:`** calls **`[window performWindowDragWithEvent:event]`** — the standard AppKit API for dragging a window from an arbitrary view.
- **Why stack it `NSWindowAbove`:** Electrobun may insert or reorder the WKWebView after our first layout pass. If the drag view sits under the web view, only a **one-pixel seam** (if anything) remains draggable. Main-process **`applyMacOSWindowEffects`** re-runs alignment on **resize**, **move**, and **webview `dom-ready`** (with short delays) so the strip is restacked and reframed.

### Right, bottom, and bottom-right — resize

- Three **`ElizaResizeStripView`** instances (identifiers `ElizaResizeStripRight`, `ElizaResizeStripBottom`, `ElizaResizeStripCorner`) are **invisible** views placed along the **inner** right and bottom edges and the **bottom-right** corner.
- **Cursor:** each view implements **`resetCursorRects`** and **`addCursorRect:cursor:`** so **AppKit** applies the correct resize cursor while the pointer is over that view — **without** competing with WebKit for the page body.
- **Resize:** **`mouseDown:`** runs a small **modal loop** (`nextEventMatchingMask:` for drag + up) that adjusts **`[window setFrame:display:]`** for east / south / south-east, clamped to **`minSize`** / **`maxSize`**.
- **Why not rely on the system frame resize alone:** with a full-bleed web view, the **interior** edges are not the same as the window’s outer resize border; users expect to grab a **thick** inner chrome band. The overlays define that band explicitly.
- **Z-order:** strips are **below** the top drag view (so the title region still moves the window) but **above** each other as: bottom → right → corner, so the **corner** wins hit-testing for the **diagonal** cursor (macOS 15+ uses `frameResizeCursorFromPosition:` for BR; older falls back to `crosshair`).

### Legacy right-edge drag strip

Electrobun historically could add a **right-edge** `ElectrobunNativeDragView` used for dragging. That **conflicted** with resizing from the right edge. **`setNativeWindowDragRegion`** removes that legacy view when present so the right band is reserved for **resize** overlays.

### Per-screen thickness (`height: 0`)

The same **depth** (in points) is used for:

- The **top** drag strip height, and  
- The **right / bottom / corner** resize overlays.

**Why not a single constant (e.g. 26pt):** on **1x** vs **2x** displays and very **wide** desktops, a fixed value is either a fat obstruction or a too-narrow hit target. When the host passes **`height ≤ 0`**, **`elizaChromeDepthPoints`** derives thickness from **`window.screen`** (`backingScaleFactor`, visible width hints) and clamps to a sane range. The host can still pass a **positive** value to pin depth (debugging or product override).

**Why `move` as well as `resize` in TS:** moving the window to another display updates **`window.screen`**; **resize** alone might not fire, so **`win.on("move", alignChrome)`** keeps native geometry in sync.

## Layer map (WHO does WHAT)

| Layer | Location | Role | WHY |
|-------|-----------|------|-----|
| **AppKit overlays** | `apps/app/electrobun/native/macos/window-effects.mm` | Drag strip, resize strips, vibrancy, traffic lights | Only layer that can sit **above** WKWebView and own both **hit testing** and **cursor rects** reliably. |
| **Dylib build** | `apps/app/electrobun/scripts/build-macos-effects.sh` → `libMacWindowEffects.dylib` | Ships native code consumed via Bun FFI | Keeps Objective-C++ out of the main TS bundle; rebuild after changing `.mm`. |
| **FFI + types** | `apps/app/electrobun/src/native/mac-window-effects.ts` | `setNativeDragRegion`, `enableVibrancy`, etc. | Thin typed bridge; JSDoc describes `height` semantics (`0` = auto from screen). |
| **Electrobun main** | `apps/app/electrobun/src/index.ts` | `applyMacOSWindowEffects`, `alignChrome` on resize/move/dom-ready | **Re-entrants** native layout whenever the web view or window geometry changes. |
| **CSS** | `eliza/packages/app-core/src/styles/electrobun-mac-window-drag.css` | `-webkit-app-region: drag` / `no-drag` when `html.eliza-electrobun-frameless` | Helps **Chromium** and documents intent; **not** the source of truth for WKWebView resize cursors. |
| **Class toggle** | `apps/app/src/main.tsx` | Adds `eliza-electrobun-frameless` on macOS Electrobun main shell | Gates CSS; skipped for **detached** shells where a normal window chrome may apply. |

## Related window flags

**`setMovableByWindowBackground:YES`** (set in **`enableWindowVibrancy`**) lets some clicks in “empty” or non-client areas participate in **window move** together with the explicit drag view. **Why:** WKWebView layout varies; this is a **fallback**, not a substitute for the native top strip.

## Changing behavior safely

- **Thickness / auto depth:** adjust **`elizaChromeDepthPoints`** or the host constant **`MAC_NATIVE_DRAG_REGION_HEIGHT`** in `index.ts` (`0` = auto).
- **Drag strip horizontal inset:** **`MAC_NATIVE_DRAG_REGION_X`** (traffic-light clearance).
- **After editing `.mm`:** from `apps/app/electrobun`, run `bun run build:native-effects` (wraps `scripts/build-macos-effects.sh`).

## See also

- [Desktop app (Electrobun)](/apps/desktop) — install, runtime modes, native modules.
- [Electrobun startup](../electrobun-startup.md) — why main-process / agent guards must stay (desktop bootstrap).

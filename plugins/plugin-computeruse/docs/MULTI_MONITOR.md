# Multi-monitor capture & coordinate contract (WS5)

This plugin treats every physical display as an independent scene. There is
NO virtual-desktop coordinate space exposed to the agent or the model.

## Display enumeration

`platform/displays.ts` returns the live attached set:

```ts
{
  id: number,                          // OS-stable handle or 0-based index
  bounds: [x, y, w, h],                // OS-global pixel space
  scaleFactor: number,                 // 1 on Linux/Win, >1 on retina
  primary: boolean,
  name: string                         // e.g. "eDP-1", "DISPLAY1"
}
```

Per-OS source:

| OS              | Source                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| Linux X11       | `xrandr --listmonitors`                                                 |
| Linux Wayland   | `hyprctl monitors -j` / `swaymsg -t get_outputs` (else falls back to X) |
| macOS           | `system_profiler SPDisplaysDataType -json`, then JXA `CGMainDisplayID`  |
| Windows         | PowerShell `[Screen]::AllScreens`                                       |

Native sidecars (Swift ScreenCaptureKit, DXGI/WGC, Rust libdisplay) are a
follow-up — the interface is shaped to absorb them without changing callers.

## Per-display capture

`platform/capture.ts` is the canonical capture entry point:

```ts
captureDisplay(id):       Promise<{ display, frame: PNG-Buffer }>
captureAllDisplays():     Promise<DisplayCapture[]>
captureDisplayRegion():   Promise<DisplayCapture>     // local-to-display region
```

`frame` is at backing-store resolution. On a 2× retina display reporting a
2560×1440 logical bounds with `scaleFactor: 2`, the PNG is 5120×2880.

The legacy single-display `captureScreenshot()` from `screenshot.ts` is still
exported for back-compat, but new code should prefer the per-display path.

## Coordinate contract

Every coordinate-bearing action accepts:

```ts
{
  displayId: number,           // which display the coords belong to
  coordinate: [x, y],          // LOCAL to that display
  coordSource?: "logical"|"backing"  // default "logical"
}
```

`platform/coords.ts::localToGlobal` translates to OS-global before the input
driver fires. The model never sees OS-global coords.

### Per-OS translation

- **Linux/X11**: global = display.x + local.x. Pixels-to-pixels, no DPI.
- **Windows (PerMonitorV2)**: same. Process MUST be PerMonitorV2 DPI-aware
  (manifest entry — Electrobun handles this for the desktop app).
- **macOS**: Quartz event coords are in *points* (logical pixels), not the
  backing-store resolution of the capture. If the model used the raw retina
  capture to choose coords, it must declare `coordSource: "backing"` so the
  translator divides by `scaleFactor` before adding the display origin.

### Why local-first

1. Local coords match the model's actual visual context — it analyzed one
   capture, not a stitched virtual desktop.
2. Virtual-desktop coords are a perpetual bug source: negative origins
   when secondary is left-of-primary, mixed DPI tiles, X11 vs CG origin
   conventions.
3. `displayId` is opaque to the model — it just echoes whatever the
   `displays[]` provider gave it.

### Backwards compatibility

If `displayId` is omitted, the service:

1. On single-display hosts: silently defaults to primary (debug-log only).
2. On multi-display hosts: warns once per process, then defaults to
   primary. Plan: this fallback will be removed once all in-tree callers
   are migrated.

## Ultrawide

> 21:9 displays are NOT sliced. Each `displayId` is one scene. The
aspect-aware patcher in WS6/WS7 sends the whole frame at the model's
`max_pixels` budget; M-RoPE preserves aspect inside the model.

## Provider surface

`computerState` provider includes `data.displays: DisplayDescriptor[]` and
in-text `computer_use.displays`. The planner reads this to pick a target
display before issuing any coordinate-bearing COMPUTER_USE action.

## What's manually validated

This Linux test host has a single display. Automated tests cover:

- `parseXrandrMonitors()` — string → DisplayInfo[] with golden fixtures.
- `parseHyprlandMonitors()`, `parseSwayOutputs()` — JSON → DisplayInfo[].
- `parseSystemProfilerDisplays()` — macOS JSON → DisplayInfo[].
- `parseWindowsScreens()` — PowerShell JSON → DisplayInfo[].
- `localToGlobal` / `globalToLocal` round-trip.

Real multi-monitor capture & input injection on each OS still needs a
manual rig:

| What                                  | OS      | Manual check                                         |
| ------------------------------------- | ------- | ---------------------------------------------------- |
| `screencapture -D 2`                  | macOS   | dual display rig, capture each independently         |
| Retina backing-store scale            | macOS   | scaleFactor=2, capture is 2× logical bounds          |
| WGC / DXGI vs PerMonitorV2 DPI        | Windows | per-monitor DPI mix, click lands on correct pixel    |
| Wayland portal capture                | Linux   | GNOME 45+ / KDE 6 — needs a portal-based sidecar     |
| Hyprland / Sway parser                | Linux   | run `hyprctl monitors -j` against live compositor    |

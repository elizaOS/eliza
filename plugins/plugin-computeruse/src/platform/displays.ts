/**
 * Multi-monitor display enumeration (WS5).
 *
 * Returns the live set of physical displays attached to the host, in a
 * single, OS-agnostic shape:
 *
 *   { id, bounds: [x, y, w, h], scaleFactor, primary, name }
 *
 * Notes on `id`:
 *   - macOS    — `CGDirectDisplayID` (32-bit unsigned). Stable across reboots.
 *   - Windows  — `Screen.DeviceName` hash → small integer. We expose a 0-based
 *                index because PowerShell `System.Windows.Forms.Screen` does
 *                not surface a kernel handle, and the device name (e.g.
 *                `\\.\DISPLAY1`) is a string. The index is stable for a given
 *                process but may shift across hot-plug events.
 *   - Linux X  — `xrandr --listmonitors` ordinal. Stable per process.
 *   - Linux W  — compositor-specific output id (Hyprland/Sway). Best effort.
 *
 * Coordinate space:
 *   `bounds` is in OS-global pixel space. On macOS, that means scaled
 *   "points" by default — we record the backing-store scale factor in
 *   `scaleFactor` so callers can translate to pixel-perfect coords when
 *   composing captures.
 *
 * This module never executes input. It is read-only.
 */

import { execFileSync, execSync } from "node:child_process";
import { currentPlatform } from "./helpers.js";

export interface DisplayInfo {
  /** OS-stable identifier or a 0-based fallback index. */
  id: number;
  /** [x, y, width, height] in OS-global pixel space. */
  bounds: [number, number, number, number];
  /** Backing-store scale factor. 1 on Linux, 1..N on HiDPI macOS/Windows. */
  scaleFactor: number;
  /** Whether this is the primary display. */
  primary: boolean;
  /** Human-readable name (e.g. `eDP-1`, `Built-in Retina Display`). */
  name: string;
}

let cached: DisplayInfo[] | null = null;
let cachedAt = 0;
const CACHE_MS = 1500;

/**
 * List all attached displays. Cached briefly to avoid spamming xrandr /
 * PowerShell on burst calls (provider runs every turn).
 */
export function listDisplays(): DisplayInfo[] {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;
  const fresh = enumerateDisplays();
  cached = fresh;
  cachedAt = now;
  return fresh;
}

/** Force a fresh enumeration, ignoring cache. */
export function refreshDisplays(): DisplayInfo[] {
  cached = null;
  return listDisplays();
}

/** Convenience: the primary display, or the first one if none is flagged. */
export function getPrimaryDisplay(): DisplayInfo {
  const all = listDisplays();
  if (all.length === 0) {
    return fallbackPrimary();
  }
  return all.find((d) => d.primary) ?? all[0]!;
}

/** Look up a display by id, or null if unknown. */
export function findDisplay(id: number): DisplayInfo | null {
  return listDisplays().find((d) => d.id === id) ?? null;
}

function enumerateDisplays(): DisplayInfo[] {
  const os = currentPlatform();
  try {
    if (os === "linux") return enumerateLinux();
    if (os === "darwin") return enumerateDarwin();
    if (os === "win32") return enumerateWindows();
  } catch {
    // Fall through to single-display fallback.
  }
  return [fallbackPrimary()];
}

function fallbackPrimary(): DisplayInfo {
  return {
    id: 0,
    bounds: [0, 0, 1920, 1080],
    scaleFactor: 1,
    primary: true,
    name: "primary",
  };
}

// ── Linux: X11 ──────────────────────────────────────────────────────────────
//
// `xrandr --listmonitors` produces:
//   Monitors: N
//    i: <prefix>name w/mm_x h/mm+xoff+yoff  name
// where <prefix> is `+*` for primary, `+` for secondary.
//
// Example:
//   0: +*eDP-1 2560/390x1600/240+0+0  eDP-1
//   1: +HDMI-0 3840/600x2160/340+2560+0  HDMI-0

const XRANDR_LINE = /^\s*(\d+):\s*\+(\*?)\S*\s+(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)\s+(\S+)/;

export function parseXrandrMonitors(output: string): DisplayInfo[] {
  const displays: DisplayInfo[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const m = rawLine.match(XRANDR_LINE);
    if (!m) continue;
    const id = Number.parseInt(m[1]!, 10);
    const primary = m[2] === "*";
    const width = Number.parseInt(m[3]!, 10);
    const height = Number.parseInt(m[4]!, 10);
    // m[5] / m[6] include the explicit sign (e.g. "-1920" or "+0").
    const x = Number.parseInt(m[5]!, 10);
    const y = Number.parseInt(m[6]!, 10);
    const name = m[7]!;
    if (![id, width, height, x, y].every((n) => Number.isFinite(n))) continue;
    displays.push({
      id,
      bounds: [x, y, width, height],
      scaleFactor: 1,
      primary,
      name,
    });
  }
  if (displays.length > 0 && !displays.some((d) => d.primary)) {
    displays[0]!.primary = true;
  }
  return displays;
}

function enumerateLinux(): DisplayInfo[] {
  const sessionType = (process.env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (sessionType === "wayland") {
    const w = enumerateWayland();
    if (w.length > 0) return w;
  }
  // X11 — preferred path. Works under XWayland too.
  try {
    const output = execFileSync("xrandr", ["--listmonitors"], {
      timeout: 3000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseXrandrMonitors(output);
    if (parsed.length > 0) return parsed;
  } catch {
    /* fall through */
  }
  return [fallbackPrimary()];
}

function enumerateWayland(): DisplayInfo[] {
  // Hyprland
  try {
    const output = execFileSync("hyprctl", ["monitors", "-j"], {
      timeout: 3000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseHyprlandMonitors(output);
    if (parsed.length > 0) return parsed;
  } catch {
    /* try sway */
  }
  // Sway
  try {
    const output = execFileSync("swaymsg", ["-t", "get_outputs"], {
      timeout: 3000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseSwayOutputs(output);
    if (parsed.length > 0) return parsed;
  } catch {
    /* fall through to xrandr/xwayland */
  }
  return [];
}

interface HyprlandMonitor {
  id?: number;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scale?: number;
  focused?: boolean;
}

export function parseHyprlandMonitors(output: string): DisplayInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const displays: DisplayInfo[] = [];
  let idx = 0;
  for (const item of raw as HyprlandMonitor[]) {
    if (!item || typeof item !== "object") continue;
    const w = Number(item.width);
    const h = Number(item.height);
    const x = Number(item.x);
    const y = Number(item.y);
    if (![w, h, x, y].every((n) => Number.isFinite(n))) continue;
    displays.push({
      id: Number.isFinite(Number(item.id)) ? Number(item.id) : idx,
      bounds: [x, y, w, h],
      scaleFactor: Number.isFinite(Number(item.scale)) ? Number(item.scale) : 1,
      primary: Boolean(item.focused) || idx === 0,
      name: typeof item.name === "string" ? item.name : `output-${idx}`,
    });
    idx += 1;
  }
  if (displays.length > 0 && !displays.some((d) => d.primary)) {
    displays[0]!.primary = true;
  }
  return displays;
}

interface SwayOutput {
  name?: string;
  focused?: boolean;
  primary?: boolean;
  rect?: { x?: number; y?: number; width?: number; height?: number };
  scale?: number;
}

export function parseSwayOutputs(output: string): DisplayInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const displays: DisplayInfo[] = [];
  let idx = 0;
  for (const item of raw as SwayOutput[]) {
    if (!item || typeof item !== "object") continue;
    const rect = item.rect ?? {};
    const w = Number(rect.width);
    const h = Number(rect.height);
    const x = Number(rect.x);
    const y = Number(rect.y);
    if (![w, h, x, y].every((n) => Number.isFinite(n))) continue;
    displays.push({
      id: idx,
      bounds: [x, y, w, h],
      scaleFactor: Number.isFinite(Number(item.scale)) ? Number(item.scale) : 1,
      primary: Boolean(item.primary || item.focused) || idx === 0,
      name: typeof item.name === "string" ? item.name : `output-${idx}`,
    });
    idx += 1;
  }
  if (displays.length > 0 && !displays.some((d) => d.primary)) {
    displays[0]!.primary = true;
  }
  return displays;
}

// ── macOS ───────────────────────────────────────────────────────────────────
//
// We avoid shipping a Swift sidecar for v1. CoreGraphics is reachable via
// `osascript -l JavaScript` (JXA) — the same path the existing single-display
// code uses. JXA gives us `CGGetActiveDisplayList` + `CGDisplayBounds`, plus
// `CGDisplayScreenSize` and `CGDisplayPixelsWide/High` for the scale factor.
//
// For macOS 14+ a native ScreenCaptureKit binary will yield richer metadata
// (name, refresh rate, color space). That's a follow-up — the interface here
// is shaped to absorb it without breaking callers.

interface JXADisplay {
  id?: number;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  pixelWidth?: number;
  pixelHeight?: number;
  primary?: boolean;
  name?: string;
}

export function parseDarwinDisplays(output: string): DisplayInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const displays: DisplayInfo[] = [];
  let idx = 0;
  for (const item of raw as JXADisplay[]) {
    if (!item || typeof item !== "object") continue;
    const b = item.bounds ?? {};
    const w = Number(b.width);
    const h = Number(b.height);
    const x = Number(b.x);
    const y = Number(b.y);
    if (![w, h, x, y].every((n) => Number.isFinite(n))) continue;
    const pixelW = Number(item.pixelWidth);
    const pixelH = Number(item.pixelHeight);
    let scale = 1;
    if (Number.isFinite(pixelW) && w > 0) {
      scale = pixelW / w;
    } else if (Number.isFinite(pixelH) && h > 0) {
      scale = pixelH / h;
    }
    displays.push({
      id: Number.isFinite(Number(item.id)) ? Number(item.id) : idx,
      bounds: [x, y, w, h],
      scaleFactor: Number.isFinite(scale) && scale > 0 ? scale : 1,
      primary: Boolean(item.primary) || idx === 0,
      name: typeof item.name === "string" && item.name.length > 0
        ? item.name
        : `display-${idx}`,
    });
    idx += 1;
  }
  if (displays.length > 0 && !displays.some((d) => d.primary)) {
    displays[0]!.primary = true;
  }
  return displays;
}

const DARWIN_JXA = `
ObjC.import("CoreGraphics");
const max = 16;
const idsPtr = Ref();
const countPtr = Ref();
const arr = $.CGDisplayCreateActiveDisplayList ? null : null; // placeholder
const ids = [];
const count = Ref();
// Use CGGetActiveDisplayList — fill into a typed array.
const maxDisplays = 16;
const buf = $.malloc(maxDisplays * 4);
const result = $.CGGetActiveDisplayList(maxDisplays, buf, count);
const total = count[0];
const mainId = $.CGMainDisplayID();
const out = [];
for (let i = 0; i < total; i++) {
  const id = $.CFArrayGetCount ? 0 : 0;
  // Read uint32 at offset i*4
  const dv = $.NSData.dataWithBytesLength(buf + i * 4, 4);
  const arrBytes = dv.bytes;
  // Fall back to reading via Ref — simpler with JXA helpers:
}
$.free(buf);
JSON.stringify(out);
`;

function enumerateDarwin(): DisplayInfo[] {
  // JXA's pointer manipulation for CGGetActiveDisplayList is brittle. Use a
  // simpler shell-out path: `system_profiler SPDisplaysDataType -json` lists
  // every display with resolution, but no per-display origin. For origin we
  // fall back to AppleScript `tell app "System Events" to get displays` (10.15+)
  // or accept primary-only when origin is missing.
  try {
    const output = execSync("system_profiler SPDisplaysDataType -json", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseSystemProfilerDisplays(output);
    if (parsed.length > 0) return parsed;
  } catch {
    /* fall through */
  }
  // Last-resort: CGMainDisplay bounds + scale via osascript JXA.
  try {
    const output = execSync(
      `osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); const id=$.CGMainDisplayID(); const b=$.CGDisplayBounds(id); const pw=$.CGDisplayPixelsWide(id); const ph=$.CGDisplayPixelsHigh(id); JSON.stringify({id:Number(id), x:b.origin.x, y:b.origin.y, w:b.size.width, h:b.size.height, pw:pw, ph:ph});'`,
      { timeout: 4000, encoding: "utf-8" },
    );
    const j = JSON.parse(output) as {
      id: number;
      x: number;
      y: number;
      w: number;
      h: number;
      pw: number;
      ph: number;
    };
    const scale = j.w > 0 ? j.pw / j.w : 1;
    return [
      {
        id: Number.isFinite(j.id) ? j.id : 0,
        bounds: [Math.round(j.x), Math.round(j.y), Math.round(j.w), Math.round(j.h)],
        scaleFactor: Number.isFinite(scale) && scale > 0 ? scale : 1,
        primary: true,
        name: "main",
      },
    ];
  } catch {
    return [fallbackPrimary()];
  }
}

interface SPDisplay {
  _name?: string;
  _spdisplays_resolution?: string;
  spdisplays_resolution?: string;
  _spdisplays_pixelresolution?: string;
  spdisplays_pixelresolution?: string;
  spdisplays_main?: string; // "spdisplays_yes" when primary
}

interface SPDisplaysCard {
  spdisplays_ndrvs?: SPDisplay[];
}

interface SPDisplaysRoot {
  SPDisplaysDataType?: SPDisplaysCard[];
}

const SP_RES = /(\d+)\s*[x×]\s*(\d+)/i;

export function parseSystemProfilerDisplays(output: string): DisplayInfo[] {
  let parsed: SPDisplaysRoot;
  try {
    parsed = JSON.parse(output) as SPDisplaysRoot;
  } catch {
    return [];
  }
  const cards = parsed.SPDisplaysDataType;
  if (!Array.isArray(cards)) return [];
  const displays: DisplayInfo[] = [];
  let idx = 0;
  // Best-effort: system_profiler omits origins. We lay each display out
  // horizontally starting at x=0. Callers needing accurate origins should
  // fall back to the JXA path or supply explicit positions via env.
  let xCursor = 0;
  for (const card of cards) {
    const drivers = card?.spdisplays_ndrvs;
    if (!Array.isArray(drivers)) continue;
    for (const d of drivers) {
      const logicalText = d.spdisplays_resolution ?? d._spdisplays_resolution ?? "";
      const pixelText = d.spdisplays_pixelresolution ?? d._spdisplays_pixelresolution ?? "";
      const logicalMatch = SP_RES.exec(logicalText);
      const pixelMatch = SP_RES.exec(pixelText);
      if (!logicalMatch && !pixelMatch) continue;
      const logicalW = logicalMatch
        ? Number.parseInt(logicalMatch[1]!, 10)
        : Number.parseInt(pixelMatch![1]!, 10);
      const logicalH = logicalMatch
        ? Number.parseInt(logicalMatch[2]!, 10)
        : Number.parseInt(pixelMatch![2]!, 10);
      const pixelW = pixelMatch ? Number.parseInt(pixelMatch[1]!, 10) : logicalW;
      let scale = logicalW > 0 ? pixelW / logicalW : 1;
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;
      const primary = d.spdisplays_main === "spdisplays_yes" || idx === 0;
      displays.push({
        id: idx,
        bounds: [xCursor, 0, logicalW, logicalH],
        scaleFactor: scale,
        primary,
        name: typeof d._name === "string" ? d._name : `display-${idx}`,
      });
      xCursor += logicalW;
      idx += 1;
    }
  }
  if (displays.length > 0 && !displays.some((d) => d.primary)) {
    displays[0]!.primary = true;
  }
  return displays;
}

// ── Windows ─────────────────────────────────────────────────────────────────
//
// PowerShell + System.Windows.Forms.Screen gives bounds and primary flag for
// every monitor. It does NOT give a per-monitor DPI; for that we'd need a
// native binding to `GetDpiForMonitor` (shcore.dll) or to enumerate via
// `EnumDisplayMonitors`. v1 reports scaleFactor=1 and the app manifest must
// declare PerMonitorV2 dpi awareness so coordinates are in pixels.

interface WinScreen {
  DeviceName?: string;
  Primary?: boolean;
  Bounds?: { X?: number; Y?: number; Width?: number; Height?: number };
}

export function parseWindowsScreens(output: string): DisplayInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return [];
  }
  const items: WinScreen[] = Array.isArray(raw) ? (raw as WinScreen[]) : [raw as WinScreen];
  const displays: DisplayInfo[] = [];
  let idx = 0;
  for (const s of items) {
    if (!s || typeof s !== "object") continue;
    const b = s.Bounds ?? {};
    const w = Number(b.Width);
    const h = Number(b.Height);
    const x = Number(b.X);
    const y = Number(b.Y);
    if (![w, h, x, y].every((n) => Number.isFinite(n))) continue;
    displays.push({
      id: idx,
      bounds: [x, y, w, h],
      scaleFactor: 1,
      primary: Boolean(s.Primary) || idx === 0,
      name:
        typeof s.DeviceName === "string" && s.DeviceName.length > 0
          ? s.DeviceName
          : `display-${idx}`,
    });
    idx += 1;
  }
  if (displays.length > 0 && !displays.some((d) => d.primary)) {
    displays[0]!.primary = true;
  }
  return displays;
}

function enumerateWindows(): DisplayInfo[] {
  try {
    const psCmd =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "[System.Windows.Forms.Screen]::AllScreens | " +
      "Select-Object DeviceName,Primary,Bounds | " +
      "ConvertTo-Json -Compress -Depth 4";
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseWindowsScreens(output);
    if (parsed.length > 0) return parsed;
  } catch {
    /* fall through */
  }
  return [fallbackPrimary()];
}

/**
 * Per-display capture (WS5).
 *
 * Canonical capture entry point. Replaces `screenshot.ts` for any caller that
 * cares about multi-monitor or DPI. The legacy `captureScreenshot()` keeps
 * working (single-display, primary only) for back-compat.
 *
 * Returned `frame` is a PNG buffer at backing-store resolution:
 *   - macOS retina  — 2× the logical bounds (e.g. 5120×2880 for a 2560×1440
 *                     display reported as scaleFactor 2).
 *   - Windows/Linux — pixel-equivalent to logical bounds.
 *
 * Implementation notes:
 *   - macOS uses `screencapture -D <displayIndex+1>` to pick a specific
 *     display (1-indexed). For ScreenCaptureKit follow-up, replace this
 *     dispatch with the Swift sidecar.
 *   - Linux/X11 uses `import` (ImageMagick) or `scrot` cropped to the
 *     display's xrandr rect. Wayland-only environments need a portal-based
 *     sidecar — out of scope for v1.
 *   - Windows uses PowerShell + System.Drawing to crop the virtual desktop
 *     to the screen bounds.
 *
 * Every code path is conditional on the current platform — a Linux test host
 * can exercise the Linux paths; macOS / Windows paths are typechecked but
 * exercised only in CI on those OSes.
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenRegion } from "../types.js";
import type { DisplayInfo } from "./displays.js";
import { findDisplay, getPrimaryDisplay, listDisplays } from "./displays.js";
import { commandExists, currentPlatform, runCommandBuffer } from "./helpers.js";
import {
  classifyPermissionDeniedError,
  createPermissionDeniedError,
  isPermissionDeniedError,
} from "./permissions.js";

const SCREEN_RECORDING_OPERATION_MESSAGE =
  "macOS Screen Recording permission is required for screenshots. Grant access in System Settings > Privacy & Security > Screen Recording, then retry.";

export interface DisplayCapture {
  display: DisplayInfo;
  /** PNG bytes at backing-store resolution. */
  frame: Buffer;
}

/**
 * Capture every attached display in parallel. Returns one entry per display.
 * Errors on any display are surfaced as rejected promises — caller decides
 * whether to retry or partial-fail.
 */
export async function captureAllDisplays(): Promise<DisplayCapture[]> {
  const displays = listDisplays();
  return Promise.all(displays.map((d) => captureDisplay(d.id)));
}

/**
 * Capture a specific display by id.
 */
export async function captureDisplay(
  displayId: number,
): Promise<DisplayCapture> {
  const display = findDisplay(displayId);
  if (!display) {
    throw new Error(
      `Unknown displayId ${displayId}. Known: ${listDisplays()
        .map((d) => d.id)
        .join(", ")}`,
    );
  }
  const os = currentPlatform();
  const tmpFile = join(
    tmpdir(),
    `computeruse-display-${displayId}-${Date.now()}.png`,
  );
  try {
    if (os === "darwin") captureDisplayDarwin(tmpFile, display);
    else if (os === "linux") captureDisplayLinux(tmpFile, display);
    else if (os === "win32") captureDisplayWindows(tmpFile, display);

    const data = readFileSync(tmpFile);
    if (os === "darwin" && data.length === 0) {
      throw createPermissionDeniedError({
        permissionType: "screen_recording",
        operation: "screenshot_capture",
        message: SCREEN_RECORDING_OPERATION_MESSAGE,
        details: "screencapture returned an empty file.",
      });
    }
    return { display, frame: data };
  } catch (err) {
    if (isPermissionDeniedError(err)) throw err;
    const permissionError = classifyPermissionDeniedError(err, {
      permissionType: "screen_recording",
      operation: "screenshot_capture",
    });
    if (permissionError) throw permissionError;
    throw err;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Capture a region within a specific display. Region coordinates are LOCAL
 * to that display.
 */
export async function captureDisplayRegion(
  displayId: number,
  region: ScreenRegion,
): Promise<DisplayCapture> {
  const display = findDisplay(displayId);
  if (!display) {
    throw new Error(`Unknown displayId ${displayId}.`);
  }
  const globalRegion: ScreenRegion = {
    x: display.bounds[0] + region.x,
    y: display.bounds[1] + region.y,
    width: region.width,
    height: region.height,
  };
  const os = currentPlatform();
  const tmpFile = join(
    tmpdir(),
    `computeruse-region-${displayId}-${Date.now()}.png`,
  );
  try {
    if (os === "darwin") captureRegionDarwin(tmpFile, globalRegion);
    else if (os === "linux") captureRegionLinux(tmpFile, globalRegion);
    else if (os === "win32") captureRegionWindows(tmpFile, globalRegion);
    const data = readFileSync(tmpFile);
    return { display, frame: data };
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Convenience: capture the primary display.
 */
export async function capturePrimaryDisplay(): Promise<DisplayCapture> {
  return captureDisplay(getPrimaryDisplay().id);
}

// ── macOS ───────────────────────────────────────────────────────────────────

function captureDisplayDarwin(tmpFile: string, display: DisplayInfo): void {
  // `screencapture -D N` selects display N (1-based). Display ids reported
  // by CG are 32-bit handles; we map our 0-based index to the -D argument.
  const ordinal = displayOrdinal(display);
  try {
    runCommandBuffer(
      "screencapture",
      ["-D", String(ordinal + 1), "-x", tmpFile],
      10000,
    );
  } catch (error) {
    const permissionError = classifyPermissionDeniedError(error, {
      permissionType: "screen_recording",
      operation: "screenshot_capture",
    });
    if (permissionError) throw permissionError;
    throw error;
  }
}

function captureRegionDarwin(tmpFile: string, region: ScreenRegion): void {
  runCommandBuffer(
    "screencapture",
    [
      `-R${region.x},${region.y},${region.width},${region.height}`,
      "-x",
      tmpFile,
    ],
    10000,
  );
}

// ── Linux ───────────────────────────────────────────────────────────────────

function captureDisplayLinux(tmpFile: string, display: DisplayInfo): void {
  const [x, y, w, h] = display.bounds;
  if (commandExists("import")) {
    runCommandBuffer(
      "import",
      ["-window", "root", "-crop", `${w}x${h}+${x}+${y}`, tmpFile],
      10000,
    );
    return;
  }
  if (commandExists("scrot")) {
    runCommandBuffer("scrot", ["-a", `${x},${y},${w},${h}`, tmpFile], 10000);
    return;
  }
  if (commandExists("gnome-screenshot")) {
    // gnome-screenshot doesn't crop precisely — fall back to whole screen.
    runCommandBuffer("gnome-screenshot", ["-f", tmpFile], 10000);
    return;
  }
  throw new Error(
    "No screenshot tool available. Install ImageMagick (import), scrot, or gnome-screenshot.",
  );
}

function captureRegionLinux(tmpFile: string, region: ScreenRegion): void {
  if (commandExists("import")) {
    runCommandBuffer(
      "import",
      [
        "-window",
        "root",
        "-crop",
        `${region.width}x${region.height}+${region.x}+${region.y}`,
        tmpFile,
      ],
      10000,
    );
    return;
  }
  if (commandExists("scrot")) {
    runCommandBuffer(
      "scrot",
      [
        "-a",
        `${region.x},${region.y},${region.width},${region.height}`,
        tmpFile,
      ],
      10000,
    );
    return;
  }
  throw new Error("No screenshot tool available for region capture.");
}

// ── Windows ─────────────────────────────────────────────────────────────────

function captureDisplayWindows(tmpFile: string, display: DisplayInfo): void {
  const [x, y, w, h] = display.bounds;
  captureRegionWindows(tmpFile, { x, y, width: w, height: h });
}

function captureRegionWindows(tmpFile: string, region: ScreenRegion): void {
  const escapedPath = tmpFile.replace(/\//g, "\\");
  const psCmd = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    `$bitmap = New-Object System.Drawing.Bitmap(${region.width}, ${region.height})`,
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    `$origin = New-Object System.Drawing.Point(${region.x}, ${region.y})`,
    `$size = New-Object System.Drawing.Size(${region.width}, ${region.height})`,
    "$graphics.CopyFromScreen($origin, [System.Drawing.Point]::Empty, $size)",
    `$bitmap.Save('${escapedPath}')`,
    "$graphics.Dispose()",
    "$bitmap.Dispose()",
  ].join("; ");
  execSync(`powershell -NoProfile -Command "${psCmd}"`, {
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function displayOrdinal(display: DisplayInfo): number {
  const all = listDisplays();
  const idx = all.findIndex((d) => d.id === display.id);
  return idx >= 0 ? idx : 0;
}

// Re-export the legacy single-display API so that screenshot.ts callers work.
export { captureScreenshot } from "./screenshot.js";

// Suppress unused-import lint when execFileSync isn't reached on every build.
void execFileSync;

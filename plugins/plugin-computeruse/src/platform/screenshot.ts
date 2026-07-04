/**
 * Cross-platform screenshot capture.
 *
 * Ported from:
 * - coasty-ai/open-computer-use screenshot.ts (Apache 2.0)
 * - eliza sandbox-routes.ts captureScreenshot()
 *
 * Uses native CLI tools — no Electron dependency.
 * Full logical resolution is preserved (critical for accurate coordinate mapping).
 */

import { execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenRegion } from "../types.js";
import { commandExists, currentPlatform, runCommandBuffer } from "./helpers.js";
import {
  classifyPermissionDeniedError,
  createPermissionDeniedError,
  isPermissionDeniedError,
} from "./permissions.js";
import { psHostAvailable, runPsHost } from "./ps-host.js";
import { tagScreenshotError } from "./screenshot-errors.js";
import {
  canUseWaylandScreenshotPortal,
  captureWaylandPortalScreenshot,
  isWaylandSession,
} from "./wayland-portal.js";

const SCREEN_RECORDING_OPERATION_MESSAGE =
  "macOS Screen Recording permission is required for screenshots. Grant access in System Settings > Privacy & Security > Screen Recording, then retry.";

/**
 * Capture a screenshot of the entire screen (or a region) and return as a Buffer (PNG).
 */
export async function captureScreenshot(
  region?: ScreenRegion,
): Promise<Buffer> {
  const os = currentPlatform();
  const tmpFile = join(tmpdir(), `computeruse-screenshot-${Date.now()}.png`);

  try {
    if (os === "darwin") {
      captureDarwin(tmpFile, region);
    } else if (os === "linux") {
      captureLinux(tmpFile, region);
    } else if (os === "win32") {
      await captureWindows(tmpFile, region);
    }

    const data = readFileSync(tmpFile);
    if (os === "darwin" && data.length === 0) {
      throw createPermissionDeniedError({
        permissionType: "screen_recording",
        operation: "screenshot_capture",
        message: SCREEN_RECORDING_OPERATION_MESSAGE,
        details: "screencapture returned an empty file.",
      });
    }

    try {
      unlinkSync(tmpFile);
    } catch {
      // error-policy:J6 best-effort temp-file teardown; the frame is already
      // in memory.
    }
    return data;
  } catch (err) {
    try {
      unlinkSync(tmpFile);
    } catch {
      // error-policy:J6 best-effort temp-file teardown on the failure path;
      // the original error below is what surfaces.
    }

    const operation = region ? "screenshot_region" : "screenshot_capture";

    if (isPermissionDeniedError(err)) {
      throw tagScreenshotError(err, operation);
    }

    const permissionError = classifyPermissionDeniedError(err, {
      permissionType: "screen_recording",
      operation,
    });
    if (permissionError) {
      throw tagScreenshotError(permissionError, operation);
    }

    throw tagScreenshotError(err, operation);
  }
}

// ── macOS ───────────────────────────────────────────────────────────────────

function captureDarwin(tmpFile: string, region?: ScreenRegion): void {
  try {
    if (region) {
      runCommandBuffer(
        "screencapture",
        [
          `-R${region.x},${region.y},${region.width},${region.height}`,
          "-x",
          tmpFile,
        ],
        10000,
      );
    } else {
      // -x suppresses the shutter sound
      runCommandBuffer("screencapture", ["-x", tmpFile], 10000);
    }
  } catch (error) {
    const permissionError = classifyPermissionDeniedError(error, {
      permissionType: "screen_recording",
      operation: region ? "screenshot_region" : "screenshot_capture",
    });
    if (permissionError) {
      throw permissionError;
    }
    throw error;
  }
}

// ── Linux ───────────────────────────────────────────────────────────────────

function captureLinux(tmpFile: string, region?: ScreenRegion): void {
  if (!region && tryCaptureWaylandPortal(tmpFile)) return;

  // Try tools in preference order
  if (commandExists("import")) {
    if (region) {
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
    } else {
      runCommandBuffer("import", ["-window", "root", tmpFile], 10000);
    }
  } else if (commandExists("scrot")) {
    runCommandBuffer("scrot", [tmpFile], 10000);
  } else if (commandExists("gnome-screenshot")) {
    runCommandBuffer("gnome-screenshot", ["-f", tmpFile], 10000);
  } else if (commandExists("ffmpeg")) {
    // x11grab fallback for X11 hosts that ship ffmpeg but none of the dedicated
    // screenshot tools (common on dev/server boxes). Writes a single PNG frame.
    const display = process.env.DISPLAY || ":0";
    const size = region
      ? `${region.width}x${region.height}`
      : detectX11ScreenSize();
    const input = region ? `${display}+${region.x},${region.y}` : display;
    runCommandBuffer(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-video_size",
        size,
        "-i",
        input,
        "-frames:v",
        "1",
        tmpFile,
      ],
      10000,
    );
  } else {
    throw new Error(
      isWaylandSession()
        ? "No screenshot tool available. Install xdg-desktop-portal with gdbus/python3 for Wayland, or ImageMagick (import), scrot, gnome-screenshot, or ffmpeg for X11 fallback."
        : "No screenshot tool available. Install ImageMagick (import), scrot, gnome-screenshot, or ffmpeg.",
    );
  }
}

function tryCaptureWaylandPortal(tmpFile: string): boolean {
  if (!canUseWaylandScreenshotPortal()) return false;
  try {
    captureWaylandPortalScreenshot(tmpFile);
    return true;
  } catch (error) {
    if (isPermissionDeniedError(error)) throw error;
    return false;
  }
}

/** Full X11 screen size ("WxH") from xdpyinfo; a sane default if unavailable. */
function detectX11ScreenSize(): string {
  try {
    const out = execSync("xdpyinfo", { encoding: "utf8", timeout: 5000 });
    const m = out.match(/dimensions:\s+(\d+)x(\d+)/);
    if (m) return `${m[1]}x${m[2]}`;
  } catch {
    // error-policy:J4 designed degrade — the ffmpeg x11grab caller only
    // needs a plausible capture geometry; a wrong size fails loudly at
    // capture, not silently here.
  }
  return "1920x1080";
}

// ── Windows ─────────────────────────────────────────────────────────────────

async function captureWindows(
  tmpFile: string,
  _region?: ScreenRegion,
): Promise<void> {
  const escapedPath = tmpFile.replace(/\//g, "\\");
  const psCmd = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)",
    `$bitmap.Save('${escapedPath}')`,
    "$graphics.Dispose()",
    "$bitmap.Dispose()",
  ].join("; ");

  // Prefer the warm host (a cold spawn is ~10-16s on Defender hosts and would
  // ETIMEDOUT this 15s budget); fall back to the one-shot spawn.
  if (psHostAvailable()) {
    try {
      await runPsHost(psCmd, 15000);
      return;
    } catch {
      // error-policy:J4 designed two-tier execution — the one-shot spawn
      // below runs the SAME script, and its failure throws to the caller.
    }
  }
  execSync(`powershell -Command "${psCmd}"`, {
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

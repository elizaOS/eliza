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

const SCREEN_RECORDING_OPERATION_MESSAGE =
  "macOS Screen Recording permission is required for screenshots. Grant access in System Settings > Privacy & Security > Screen Recording, then retry.";

/**
 * Capture a screenshot of the entire screen (or a region) and return as a Buffer (PNG).
 */
export function captureScreenshot(region?: ScreenRegion): Buffer {
  const os = currentPlatform();
  const tmpFile = join(tmpdir(), `computeruse-screenshot-${Date.now()}.png`);

  try {
    if (os === "darwin") {
      captureDarwin(tmpFile, region);
    } else if (os === "linux") {
      captureLinux(tmpFile, region);
    } else if (os === "win32") {
      captureWindows(tmpFile, region);
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
      /* cleanup best effort */
    }
    return data;
  } catch (err) {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }

    if (isPermissionDeniedError(err)) {
      throw err;
    }

    const permissionError = classifyPermissionDeniedError(err, {
      permissionType: "screen_recording",
      operation: region ? "screenshot_region" : "screenshot_capture",
    });
    if (permissionError) {
      throw permissionError;
    }

    throw err;
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
  } else {
    throw new Error(
      "No screenshot tool available. Install ImageMagick (import), scrot, or gnome-screenshot.",
    );
  }
}

// ── Windows ─────────────────────────────────────────────────────────────────

function captureWindows(tmpFile: string, _region?: ScreenRegion): void {
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

  execSync(`powershell -Command "${psCmd}"`, {
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

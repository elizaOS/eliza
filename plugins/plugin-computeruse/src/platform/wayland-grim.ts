/**
 * Native grim capture for Wayland compositors that do not implement the
 * portal Screenshot interface. Arguments keep frames in logical coordinates,
 * select one compositor output when requested, and never invoke a shell.
 */
import type { ScreenRegion } from "../types.js";
import { commandExists, runCommandBuffer } from "./helpers.js";

export function waylandGrimArgs(
  tmpFile: string,
  region?: ScreenRegion,
  outputName?: string,
): string[] {
  return [
    "-s",
    "1",
    ...(outputName ? ["-o", outputName] : []),
    ...(region
      ? ["-g", `${region.x},${region.y} ${region.width}x${region.height}`]
      : []),
    tmpFile,
  ];
}

export function tryCaptureWaylandGrim(
  tmpFile: string,
  region?: ScreenRegion,
  outputName?: string,
): boolean {
  if (!commandExists("grim")) return false;
  try {
    runCommandBuffer(
      "grim",
      waylandGrimArgs(tmpFile, region, outputName),
      10000,
    );
    return true;
  } catch {
    // error-policy:J4 grim is a compositor-specific tier; callers continue
    // through the portal/X11 fallback and surface the final classified error.
    return false;
  }
}

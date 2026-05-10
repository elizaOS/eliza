/**
 * Shared bridge helpers for native permission probers.
 *
 * Consolidates:
 *   - platform detection
 *   - osascript shellouts (used for AppleScript permission checks)
 *   - bundle identifier resolution and TCC.db reads
 *   - bun:ffi loader for the existing macOS permissions dylib
 *     (`libMacWindowEffects.dylib`, built under
 *     `packages/app-core/platforms/electrobun/src/`)
 *
 * The TCC.db read trick lets us answer `check()` without triggering an OS
 * dialog: TCC's authorization database is readable via sqlite3 for the
 * current user. This is the canonical "preflight" technique used elsewhere
 * in the codebase (see `permissions-darwin.ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  PermissionId,
  PermissionPlatform,
  PermissionState,
  PermissionStatus,
} from "../contracts.js";

export const PLATFORM: PermissionPlatform =
  process.platform as PermissionPlatform;

export const IS_DARWIN = PLATFORM === "darwin";

/**
 * Build a `PermissionState` with sane defaults (`lastChecked = now`,
 * platform pre-filled). Caller fills the parts that vary.
 */
export function buildState(
  id: PermissionId,
  status: PermissionStatus,
  options: Partial<
    Omit<PermissionState, "id" | "status" | "lastChecked" | "platform">
  > = {},
): PermissionState {
  const state: PermissionState = {
    id,
    status,
    lastChecked: Date.now(),
    canRequest: options.canRequest ?? status === "not-determined",
    platform: PLATFORM,
  };
  if (options.restrictedReason !== undefined) {
    state.restrictedReason = options.restrictedReason;
  }
  if (options.lastRequested !== undefined) {
    state.lastRequested = options.lastRequested;
  }
  if (options.lastBlockedFeature !== undefined) {
    state.lastBlockedFeature = options.lastBlockedFeature;
  }
  return state;
}

/**
 * Short-circuit state for non-darwin platforms where the permission is a
 * macOS-only concept (Reminders, Calendar, Notes, ScreenTime, Health,
 * Accessibility, Screen Recording, Full Disk, Automation).
 */
export function platformUnsupportedState(id: PermissionId): PermissionState {
  return buildState(id, "not-applicable", {
    canRequest: false,
    restrictedReason: "platform_unsupported",
  });
}

/**
 * Run an osascript snippet and return stdout. Returns `null` on non-zero
 * exit (which happens when the user denies an Automation prompt or the
 * scripted target isn't available).
 *
 * IMPORTANT: this can trigger a TCC Automation prompt if `script` targets
 * an app the runtime hasn't been authorized for yet. Use TCC.db reads in
 * `check()` paths and reserve osascript for `request()` paths.
 */
export async function runOsascript(
  script: string,
  timeoutMs = 5000,
): Promise<string | null> {
  if (!IS_DARWIN) return null;
  try {
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // process already exited
      }
    }, timeoutMs);
    const [stdout, _stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (exitCode !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Read TCC.db for a specific service+client. Returns:
 *   - "granted"  if auth_value=2
 *   - "denied"   if auth_value=0
 *   - null       on error or row missing (caller should treat as not-determined)
 *
 * Note: macOS 11+ moves some entries to the system TCC.db
 * (`/Library/Application Support/com.apple.TCC/TCC.db`) which requires Full
 * Disk Access to read. We only consult the per-user TCC.db here.
 */
export async function queryTccStatus(
  service: string,
  bundleIdentifier: string,
): Promise<"granted" | "denied" | null> {
  if (!IS_DARWIN) return null;
  try {
    const tccDb = path.join(
      os.homedir(),
      "Library/Application Support/com.apple.TCC/TCC.db",
    );
    if (!existsSync(tccDb)) return null;

    const proc = Bun.spawn(
      [
        "sqlite3",
        tccDb,
        `SELECT auth_value FROM access WHERE service='${service}' AND client='${bundleIdentifier}'`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0 || stderr.includes("authorization denied")) return null;

    const value = stdout.trim();
    if (value === "2") return "granted";
    if (value === "0") return "denied";
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the runtime bundle identifier from the running app's Info.plist.
 * Falls back to a sensible default for dev (unsigned bun runtime).
 */
export function resolveBundleId(execPath = process.execPath): string {
  const fallback = "ai.elizaos.app";
  try {
    const macOsDir = path.dirname(path.resolve(execPath));
    const contentsDir = path.resolve(macOsDir, "..");
    const infoPlistPath = path.join(contentsDir, "Info.plist");
    if (!existsSync(infoPlistPath)) return fallback;
    const text = readFileSync(infoPlistPath, "utf8");
    const m = text.match(
      /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]+)<\/string>/s,
    );
    return m?.[1]?.trim() ?? fallback;
  } catch {
    return fallback;
  }
}

/* --------------------------------------------------------------------------
 * FFI loader for the existing native permissions dylib.
 *
 * The Electrobun runtime ships `libMacWindowEffects.dylib` which exposes:
 *   - checkAccessibilityPermission / requestAccessibilityPermission
 *   - checkScreenRecordingPermission / requestScreenRecordingPermission
 *   - checkMicrophonePermission / requestMicrophonePermission
 *   - checkCameraPermission / requestCameraPermission
 *
 * We re-use it rather than ship a parallel implementation. If the dylib
 * isn't present (e.g. running in CI or a tree where the native build hasn't
 * happened) we fall back to TCC.db reads / AVCaptureDevice via osascript /
 * not-determined.
 * -------------------------------------------------------------------------- */

interface NativePermissionsLib {
  requestAccessibilityPermission: () => boolean;
  checkAccessibilityPermission: () => boolean;
  requestScreenRecordingPermission: () => boolean;
  checkScreenRecordingPermission: () => boolean;
  checkMicrophonePermission: () => number;
  checkCameraPermission: () => number;
  requestCameraPermission: () => void;
  requestMicrophonePermission: () => void;
}

let nativeLib: NativePermissionsLib | null = null;
let nativeLibResolved = false;

const DYLIB_CANDIDATES = [
  // Worktree layout — relative to the agent package
  "../../../../app-core/platforms/electrobun/src/libMacWindowEffects.dylib",
  // Installed package layout
  "../../../app-core/platforms/electrobun/src/libMacWindowEffects.dylib",
  // Absolute env override
  process.env.MILADY_NATIVE_PERMISSIONS_DYLIB ?? "",
].filter(Boolean);

export async function getNativeDylib(): Promise<NativePermissionsLib | null> {
  if (nativeLibResolved) return nativeLib;
  nativeLibResolved = true;
  if (!IS_DARWIN) return null;

  for (const candidate of DYLIB_CANDIDATES) {
    const dylibPath = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(import.meta.dir, candidate);
    if (!existsSync(dylibPath)) continue;
    try {
      const { dlopen, FFIType } = await import("bun:ffi");
      const { symbols } = dlopen(dylibPath, {
        requestAccessibilityPermission: { args: [], returns: FFIType.bool },
        checkAccessibilityPermission: { args: [], returns: FFIType.bool },
        requestScreenRecordingPermission: { args: [], returns: FFIType.bool },
        checkScreenRecordingPermission: { args: [], returns: FFIType.bool },
        checkMicrophonePermission: { args: [], returns: FFIType.i32 },
        checkCameraPermission: { args: [], returns: FFIType.i32 },
        requestCameraPermission: { args: [], returns: FFIType.void },
        requestMicrophonePermission: { args: [], returns: FFIType.void },
      });
      nativeLib = symbols as NativePermissionsLib;
      return nativeLib;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Map AVCaptureDevice authorizationStatus values to PermissionStatus. */
export function mapAVAuthStatus(value: number): PermissionStatus {
  if (value === 2) return "granted";
  if (value === 1) return "denied";
  if (value === 3) return "restricted";
  return "not-determined";
}

/**
 * Open System Settings to a privacy pane. Best-effort; returns nothing.
 * Used by `request()` paths after the OS has refused (or there's no API to
 * trigger the prompt programmatically).
 */
export async function openPrivacyPane(pane: string): Promise<void> {
  if (!IS_DARWIN) return;
  const url = `x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`;
  try {
    const proc = Bun.spawn(["open", url], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  } catch {
    // no-op
  }
}

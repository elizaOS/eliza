import { dlopen, FFIType } from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBrandConfig } from "../brand-config";

import type {
  PermissionCheckResult,
  PermissionStatus,
  SystemPermissionId,
} from "./permissions-shared";

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

type TccPermissionService =
  | "kTCCServiceAccessibility"
  | "kTCCServiceScreenCapture";

const DEFAULT_APP_BUNDLE_ID = getBrandConfig().appId;
const sessionPromptedPermissions = new Set<SystemPermissionId>();

let nativeLib: NativePermissionsLib | null = null;
/** After the first load attempt (success or failure), do not call `dlopen` again. */
let nativeLibResolved = false;

function getNativeLib(): NativePermissionsLib | null {
  if (nativeLibResolved) {
    return nativeLib;
  }
  nativeLibResolved = true;

  const dylibPath = path.join(import.meta.dir, "../libMacWindowEffects.dylib");
  if (!existsSync(dylibPath)) {
    console.warn(
      `[Permissions] Native permission dylib missing at ${dylibPath}. Preflight uses safe fallbacks. Build with: (cd apps/app/electrobun && bun run build:native-effects)`,
    );
    return null;
  }

  try {
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
  } catch (error) {
    console.warn("[Permissions] Failed to load native dylib:", error);
    return null;
  }
}

export function resetPermissionSessionState(): void {
  sessionPromptedPermissions.clear();
}

function markPermissionInteraction(id: SystemPermissionId): void {
  if (id === "accessibility" || id === "screen-recording") {
    sessionPromptedPermissions.add(id);
  }
}

export function mapAvAuthorizationStatus(value: number): PermissionStatus {
  if (value === 2) {
    return "granted";
  }
  if (value === 1) {
    return "denied";
  }
  if (value === 3) {
    return "restricted";
  }
  return "not-determined";
}

export function resolveSessionPermissionStatus(options: {
  granted: boolean;
  promptedThisSession: boolean;
  tccStatus?: PermissionStatus | null;
}): PermissionStatus {
  if (options.granted || options.tccStatus === "granted") {
    return "granted";
  }
  if (options.tccStatus === "denied" || options.promptedThisSession) {
    return "denied";
  }
  return "not-determined";
}

export function shouldOpenSettingsAfterMediaRequest(
  status: PermissionStatus,
): boolean {
  return status !== "granted";
}

export function extractBundleIdentifierFromInfoPlist(
  infoPlistText: string,
): string | null {
  const match = infoPlistText.match(
    /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]+)<\/string>/s,
  );
  return match?.[1]?.trim() ?? null;
}

function resolveInfoPlistPath(execPath: string): string | null {
  const macOsDir = path.dirname(path.resolve(execPath));
  const contentsDir = path.resolve(macOsDir, "..");
  const infoPlistPath = path.join(contentsDir, "Info.plist");

  if (existsSync(infoPlistPath)) {
    return infoPlistPath;
  }

  return null;
}

export function resolveRuntimeBundleIdentifier(
  execPath = process.execPath,
): string {
  try {
    const infoPlistPath = resolveInfoPlistPath(execPath);
    if (!infoPlistPath) {
      return DEFAULT_APP_BUNDLE_ID;
    }
    const infoPlistText = readFileSync(infoPlistPath, "utf8");
    return (
      extractBundleIdentifierFromInfoPlist(infoPlistText) ??
      DEFAULT_APP_BUNDLE_ID
    );
  } catch {
    return DEFAULT_APP_BUNDLE_ID;
  }
}

async function queryTccPermissionStatus(
  service: TccPermissionService,
  bundleIdentifier: string,
): Promise<PermissionStatus | null> {
  try {
    const tccDb = path.join(
      os.homedir(),
      "Library/Application Support/com.apple.TCC/TCC.db",
    );
    if (!existsSync(tccDb)) {
      return null;
    }

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

    if (exitCode !== 0 || stderr.includes("authorization denied")) {
      return null;
    }

    const authValue = stdout.trim();
    if (authValue === "2") {
      return "granted";
    }
    if (authValue === "0") {
      return "denied";
    }
    return null;
  } catch {
    return null;
  }
}

async function checkSessionAwarePermission(args: {
  id: "accessibility" | "screen-recording";
  granted: boolean;
  service: TccPermissionService;
}): Promise<PermissionCheckResult> {
  const bundleIdentifier = resolveRuntimeBundleIdentifier();
  const tccStatus = args.granted
    ? null
    : await queryTccPermissionStatus(args.service, bundleIdentifier);
  const status = resolveSessionPermissionStatus({
    granted: args.granted,
    promptedThisSession: sessionPromptedPermissions.has(args.id),
    tccStatus,
  });

  return {
    status,
    canRequest: status === "not-determined",
  };
}

export async function checkPermission(
  id: SystemPermissionId,
): Promise<PermissionCheckResult> {
  switch (id) {
    case "accessibility": {
      const granted = getNativeLib()?.checkAccessibilityPermission() ?? false;
      return checkSessionAwarePermission({
        id,
        granted,
        service: "kTCCServiceAccessibility",
      });
    }

    case "screen-recording": {
      const granted = getNativeLib()?.checkScreenRecordingPermission() ?? false;
      return checkSessionAwarePermission({
        id,
        granted,
        service: "kTCCServiceScreenCapture",
      });
    }

    case "microphone": {
      const status = mapAvAuthorizationStatus(
        getNativeLib()?.checkMicrophonePermission() ?? 0,
      );
      return {
        status,
        canRequest: status === "not-determined",
      };
    }

    case "camera": {
      const status = mapAvAuthorizationStatus(
        getNativeLib()?.checkCameraPermission() ?? 0,
      );
      return {
        status,
        canRequest: status === "not-determined",
      };
    }

    case "shell":
      return { status: "granted", canRequest: false };

    default:
      return { status: "not-applicable", canRequest: false };
  }
}

export async function requestPermission(
  id: SystemPermissionId,
): Promise<PermissionCheckResult> {
  switch (id) {
    case "accessibility": {
      markPermissionInteraction(id);
      const granted = getNativeLib()?.requestAccessibilityPermission() ?? false;
      if (!granted) {
        await openPrivacySettings(id);
      }
      return checkPermission(id);
    }

    case "screen-recording": {
      markPermissionInteraction(id);
      const granted =
        getNativeLib()?.requestScreenRecordingPermission() ?? false;
      if (!granted) {
        await openPrivacySettings(id);
      }
      return checkPermission(id);
    }

    case "camera":
      getNativeLib()?.requestCameraPermission();
      {
        const result = await checkPermission(id);
        if (shouldOpenSettingsAfterMediaRequest(result.status)) {
          await openPrivacySettings(id);
          return checkPermission(id);
        }
        return result;
      }

    case "microphone":
      getNativeLib()?.requestMicrophonePermission();
      {
        const result = await checkPermission(id);
        if (shouldOpenSettingsAfterMediaRequest(result.status)) {
          await openPrivacySettings(id);
          return checkPermission(id);
        }
        return result;
      }

    case "shell":
      return { status: "granted", canRequest: false };

    default:
      return { status: "not-applicable", canRequest: false };
  }
}

export async function openPrivacySettings(
  id: SystemPermissionId,
): Promise<void> {
  markPermissionInteraction(id);

  const paneMap: Partial<Record<SystemPermissionId, string>> = {
    accessibility:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "screen-recording":
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    microphone:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    camera:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  };

  const url = paneMap[id];
  if (!url) {
    return;
  }

  const proc = Bun.spawn(["open", url], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

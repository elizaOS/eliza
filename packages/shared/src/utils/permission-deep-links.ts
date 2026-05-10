/**
 * macOS Privacy & Security pane deep-link table.
 *
 * Maps permission ids to the `x-apple.systempreferences:` URL that opens the
 * exact pane the user needs to grant access. The chat permission card calls
 * `openPermissionSettings(id)` when a permission is denied and the user
 * clicks "Open System Settings".
 *
 * Win32 / Linux: stubbed with a console warning. Native equivalents (Windows
 * `ms-settings:privacy-*`, GNOME `gnome-control-center privacy`, etc.) can
 * be wired in when those platforms gain real support — until then the chat
 * surface advertises the limitation up-front.
 */

import type { PermissionId } from "../contracts/permissions.js";

const ROOT_PRIVACY =
  "x-apple.systempreferences:com.apple.preference.security?Privacy";

/**
 * Per-id deep links. The right-hand value is the full URL.
 * Permissions without a dedicated pane fall through to {@link ROOT_PRIVACY}.
 */
const MAC_DEEP_LINKS: Record<PermissionId, string> = {
  accessibility: `${ROOT_PRIVACY}_Accessibility`,
  "screen-recording": `${ROOT_PRIVACY}_ScreenCapture`,
  reminders: `${ROOT_PRIVACY}_Reminders`,
  calendar: `${ROOT_PRIVACY}_Calendars`,
  contacts: `${ROOT_PRIVACY}_Contacts`,
  health: `${ROOT_PRIVACY}_Health`,
  microphone: `${ROOT_PRIVACY}_Microphone`,
  camera: `${ROOT_PRIVACY}_Camera`,
  location: `${ROOT_PRIVACY}_LocationServices`,
  notifications: "x-apple.systempreferences:com.apple.preference.notifications",
  "full-disk": `${ROOT_PRIVACY}_AllFiles`,
  automation: `${ROOT_PRIVACY}_Automation`,
  // Permissions without dedicated panes — fall back to root Privacy.
  shell: ROOT_PRIVACY,
  "website-blocking": ROOT_PRIVACY,
  notes: ROOT_PRIVACY,
  screentime: "x-apple.systempreferences:com.apple.preference.screentime",
};

export function getMacPermissionDeepLink(id: PermissionId): string {
  return MAC_DEEP_LINKS[id] ?? ROOT_PRIVACY;
}

type Platform = "darwin" | "win32" | "linux" | "unknown";

function detectPlatform(): Platform {
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { process?: { platform?: string } }).process
      ?.platform === "string"
  ) {
    const p = (globalThis as { process: { platform: string } }).process
      .platform;
    if (p === "darwin" || p === "win32" || p === "linux") return p;
  }
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string"
  ) {
    const ua = navigator.userAgent;
    if (/Mac/.test(ua)) return "darwin";
    if (/Win/.test(ua)) return "win32";
    if (/Linux/.test(ua)) return "linux";
  }
  return "unknown";
}

export interface OpenPermissionSettingsDeps {
  /**
   * Optional opener. Injected for tests; defaults to `window.open` in the
   * browser/electron renderer. On Node-only contexts the caller must inject
   * something (e.g. `child_process.exec("open ...")`).
   */
  open?: (url: string) => void | Promise<void>;
  /** Override platform detection (tests). */
  platform?: Platform;
}

/**
 * Open the system settings pane for the given permission. Resolves once the
 * opener has been invoked (it doesn't wait for the user). Win32 / Linux
 * stub: logs a warning and resolves without opening anything.
 */
export async function openPermissionSettings(
  id: PermissionId,
  deps: OpenPermissionSettingsDeps = {},
): Promise<void> {
  const platform = deps.platform ?? detectPlatform();
  if (platform !== "darwin") {
    // TODO(permissions): wire ms-settings:privacy-* (win32) and
    // gnome-control-center privacy (linux) once we ship those targets.
    console.warn(
      `[permission-deep-links] openPermissionSettings is a no-op on ${platform}; permission=${id}`,
    );
    return;
  }
  const url = getMacPermissionDeepLink(id);
  const opener =
    deps.open ??
    ((u: string) => {
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(u, "_self");
      }
    });
  await opener(url);
}

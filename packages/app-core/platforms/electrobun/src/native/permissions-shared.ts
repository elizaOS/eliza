/**
 * Projects the shared permission catalog onto capabilities implemented by the
 * Electrobun desktop shell; metadata remains owned by @elizaos/shared.
 */

export type {
  AllPermissionsState,
  PermissionCheckResult,
  PermissionId,
  PermissionState,
  PermissionStatus,
  Platform,
  SystemPermissionDefinition,
} from "@elizaos/shared";

import {
  type PermissionId,
  type PermissionPlatformProjection,
  type Platform,
  projectPermissionDefinitions,
} from "@elizaos/shared";

const DESKTOP = ["darwin", "win32", "linux"] as const;
const MACOS = ["darwin"] as const;
const UNSUPPORTED = [] as const;

/** OS implementations reachable from the Electrobun main process. */
export const ELECTROBUN_PERMISSION_SUPPORT = {
  accessibility: MACOS,
  "screen-recording": MACOS,
  microphone: DESKTOP,
  camera: DESKTOP,
  shell: DESKTOP,
  "website-blocking": DESKTOP,
  location: DESKTOP,
  reminders: MACOS,
  calendar: MACOS,
  health: MACOS,
  screentime: MACOS,
  contacts: MACOS,
  notes: MACOS,
  notifications: DESKTOP,
  "full-disk": MACOS,
  automation: MACOS,
  "speech-recognition": UNSUPPORTED,
  photos: UNSUPPORTED,
  phone: UNSUPPORTED,
  messages: UNSUPPORTED,
  wifi: UNSUPPORTED,
  bluetooth: UNSUPPORTED,
  "app-blocking": UNSUPPORTED,
  "usage-access": UNSUPPORTED,
  overlay: UNSUPPORTED,
  "write-settings": UNSUPPORTED,
  "local-network": UNSUPPORTED,
  "battery-optimization": UNSUPPORTED,
} as const satisfies PermissionPlatformProjection;

export const SYSTEM_PERMISSIONS = projectPermissionDefinitions(
  ELECTROBUN_PERMISSION_SUPPORT,
);

const PERMISSION_MAP = new Map(
  SYSTEM_PERMISSIONS.map((permission) => [permission.id, permission]),
);

export function isPermissionApplicable(
  id: PermissionId,
  platform: Platform,
): boolean {
  return PERMISSION_MAP.get(id)?.platforms.includes(platform) ?? false;
}

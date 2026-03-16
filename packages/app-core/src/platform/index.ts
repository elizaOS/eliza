/**
 * Platform utilities — onboarding permissions and platform initialization helpers.
 *
 * Migrated from apps/app/src/onboarding-permissions.ts and main.tsx.
 */

import type {
  AllPermissionsState,
  PermissionStatus,
  SystemPermissionId,
} from "../api/client";

// ── Onboarding permissions ──────────────────────────────────────────────

export const REQUIRED_ONBOARDING_PERMISSION_IDS: ReadonlyArray<SystemPermissionId> =
  ["accessibility", "screen-recording", "microphone"];

export function isOnboardingPermissionGranted(
  status: PermissionStatus | undefined,
): boolean {
  return status === "granted" || status === "not-applicable";
}

export function getMissingOnboardingPermissions(
  permissions: AllPermissionsState | null | undefined,
): SystemPermissionId[] {
  if (!permissions) return [...REQUIRED_ONBOARDING_PERMISSION_IDS];
  return REQUIRED_ONBOARDING_PERMISSION_IDS.filter((id) => {
    return !isOnboardingPermissionGranted(permissions[id]?.status);
  });
}

export function hasRequiredOnboardingPermissions(
  permissions: AllPermissionsState | null | undefined,
): boolean {
  return getMissingOnboardingPermissions(permissions).length === 0;
}

// ── Platform init ───────────────────────────────────────────────────────

export { applyLaunchConnectionFromUrl } from "./browser-launch";
export {
  type DeepLinkHandlers,
  dispatchShareTarget,
  handleDeepLink,
  injectPopoutApiBase,
  isAndroid,
  isElectronPlatform,
  isIOS,
  isNative,
  isPopoutWindow,
  isWebPlatform,
  platform,
  type ShareTargetFile,
  type ShareTargetPayload,
  setupPlatformStyles,
} from "./init";
export * from "./lifo";

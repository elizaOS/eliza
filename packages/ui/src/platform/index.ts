/** Platform utilities — platform initialization helpers. */

export type * from "./types";

// Onboarding no longer requests system permissions up front. Permissions
// are requested just-in-time when a feature actually needs them (via the
// permissions registry / chat surface). The legacy
// `REQUIRED_ONBOARDING_PERMISSION_IDS` and `hasRequiredOnboardingPermissions`
// helpers were removed when the latent first-run permission walkthrough
// was deleted from `PermissionsSection.tsx`.

// ── Platform init ───────────────────────────────────────────────────────

export * from "./android-runtime";
export * from "./aosp-user-agent";
export {
  applyLaunchConnection,
  applyLaunchConnectionFromUrl,
} from "./browser-launch";
export * from "./cloud-preference-patch";
export * from "./desktop-permissions-client";
export {
  type DeepLinkHandlers,
  dispatchShareTarget,
  handleDeepLink,
  injectPopoutApiBase,
  isAndroid,
  isDesktopPlatform,
  isElizaOS,
  isIOS,
  isNative,
  isPopoutWindow,
  isWebPlatform,
  platform,
  type ShareTargetFile,
  type ShareTargetPayload,
  setupPlatformStyles,
} from "./init";
export * from "./ios-runtime";
export * from "./onboarding-reset";
export type {
  CloudPreferenceClientLike,
  OnboardingClientLike,
  PermissionsClientLike,
} from "./types";
export * from "./window-shell";

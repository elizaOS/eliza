/** Platform utilities — platform initialization helpers. */

export * from "./android-runtime";
export * from "./aosp-user-agent";
export {
  ASSISTANT_LAUNCH_PARAM_KEYS,
  ASSISTANT_LAUNCH_SOURCES,
  ASSISTANT_LAUNCH_TEXT_KEYS,
  type AssistantLaunchPayload,
  type AssistantLaunchPayloadClaimOptions,
  type AssistantLaunchPayloadConsumeOptions,
  type AssistantLaunchPayloadSendOptions,
  buildAssistantLaunchMetadata,
  claimAssistantLaunchPayloadFromHash,
  clearAssistantLaunchPayloadFromHash,
  consumeAssistantLaunchPayloadFromHash,
  readAssistantLaunchPayloadFromHash,
} from "./assistant-launch-payload";
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
export * from "./platform-guards";
export type * from "./types";
export type {
  CloudPreferenceClientLike,
  OnboardingClientLike,
  PermissionsClientLike,
} from "./types";
export * from "./window-shell";

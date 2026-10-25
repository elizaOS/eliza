/**
 * Keys and parsing for the assistant-launch deep-link payload (which query keys
 * carry the launch text).
 */
export const ASSISTANT_LAUNCH_TEXT_KEYS = [
  "text",
  "q",
  "query",
  "body",
] as const;

export const ASSISTANT_LAUNCH_PARAM_KEYS = [
  ...ASSISTANT_LAUNCH_TEXT_KEYS,
  "action",
  "assistant.launchId",
  "source",
  "voice",
  "issuedAt",
] as const;

export const ASSISTANT_LAUNCH_SOURCES = new Set([
  "android-app-actions",
  "android-assist",
  "android-assistant-session",
  "android-ime",
  "android-quick-settings",
  "android-recognition-service",
  "android-share-sheet",
  "android-static-shortcut",
  "android-widget",
  "assistant-entry",
  "ios-app-intent",
  "ios-app-intents",
  "ios-app-shortcuts",
  "ios-control",
  "ios-live-activity",
  "ios-widget",
  "macos-shortcuts",
  "macos-siri",
  "siri",
]);

export interface AssistantLaunchPayload {
  action: string | null;
  launchId: string;
  route: string;
  source: string;
  text: string;
}

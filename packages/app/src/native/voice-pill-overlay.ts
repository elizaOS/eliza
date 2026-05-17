import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";

/**
 * Bridge to the native Android `VoicePillPlugin` that owns
 * `ElizaVoicePillOverlayService` — a foreground service that draws the
 * voice pill above other apps via `WindowManager` +
 * `TYPE_APPLICATION_OVERLAY`.
 *
 * On non-Android platforms (iOS, desktop) `registerPlugin` returns a stub
 * whose method calls reject — callers must gate on `Capacitor.getPlatform()`.
 *
 * Permission model:
 * - System-signed AOSP builds: `SYSTEM_ALERT_WINDOW` is whitelisted via
 *   `packages/os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml`,
 *   so `hasOverlayPermission()` returns `{ granted: true }` at first run.
 * - Sideload / Play APKs: the user must grant via
 *   `Settings.canDrawOverlays` + `ACTION_MANAGE_OVERLAY_PERMISSION`.
 *   Call `requestOverlayPermission()` from a user gesture.
 */

export interface VoicePillMessageSentEvent {
  id: string;
  text: string;
}

export interface VoicePillOverlayPlugin {
  hasOverlayPermission(): Promise<{ granted: boolean }>;
  requestOverlayPermission(): Promise<{ granted: boolean }>;
  showOverlay(): Promise<void>;
  hideOverlay(): Promise<void>;
  setRecording(options: { recording: boolean }): Promise<void>;
  /** Programmatically push a user-role message into the overlay transcript. */
  sendMessage(options: { text: string }): Promise<{ id: string; text: string }>;
  /** Push an agent-role message into the overlay transcript. */
  pushAgentMessage(options: { id: string; text: string }): Promise<void>;

  addListener(
    eventName: "messageSent",
    handler: (event: VoicePillMessageSentEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "overlayCollapsed" | "overlayExpanded",
    handler: () => void,
  ): Promise<PluginListenerHandle>;
}

const VoicePillOverlay = registerPlugin<VoicePillOverlayPlugin>("VoicePill");

export default VoicePillOverlay;

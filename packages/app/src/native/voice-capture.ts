// Thin JS wrapper over the native Android `VoiceCapture` Capacitor plugin
// (packages/app-core/platforms/android/.../VoiceCapturePlugin.java). It
// starts/stops `ElizaVoiceCaptureService` — the microphone foreground
// service that keeps continuous-chat capture alive when the WebView is
// backgrounded. No-ops on non-Android platforms.

import { Capacitor } from "@capacitor/core";

// Mirrors VoiceContinuousMode in @elizaos/ui (off | vad-gated | always-on).
export type BackgroundCaptureMode = "off" | "vad-gated" | "always-on";

interface VoiceCapturePlugin {
  startBackgroundCapture: (options?: {
    mode?: BackgroundCaptureMode;
  }) => Promise<{ started: boolean; reason?: string }>;
  stopBackgroundCapture: () => Promise<{ stopped: boolean }>;
  setMode: (options: { mode: BackgroundCaptureMode }) => Promise<{ ok: boolean }>;
  isCaptureSupported: () => Promise<{ granted: boolean }>;
  requestMicPermission: () => Promise<{ granted: boolean }>;
}

let cached: VoiceCapturePlugin | null = null;

function getPlugin(): VoiceCapturePlugin | null {
  if (Capacitor.getPlatform() !== "android") return null;
  if (!cached) {
    cached = Capacitor.registerPlugin<VoiceCapturePlugin>("VoiceCapture");
  }
  return cached;
}

/**
 * Start the native background mic foreground service. Requests RECORD_AUDIO
 * if missing, then engages capture. Resolves false (without throwing) when
 * the permission is denied or the platform is not Android, so callers can
 * toggle UI without try/catch noise.
 */
export async function startBackgroundVoiceCapture(
  mode: BackgroundCaptureMode = "vad-gated",
): Promise<boolean> {
  const plugin = getPlugin();
  if (!plugin) return false;
  const supported = await plugin.isCaptureSupported();
  if (!supported.granted) {
    await plugin.requestMicPermission();
    const recheck = await plugin.isCaptureSupported();
    if (!recheck.granted) return false;
  }
  const result = await plugin.startBackgroundCapture({ mode });
  return result.started;
}

/** Stop the native background mic foreground service. No-op off Android. */
export async function stopBackgroundVoiceCapture(): Promise<void> {
  const plugin = getPlugin();
  if (!plugin) return;
  await plugin.stopBackgroundCapture();
}

/** Update the notification/mode of a running capture service. */
export async function setBackgroundVoiceCaptureMode(
  mode: BackgroundCaptureMode,
): Promise<void> {
  const plugin = getPlugin();
  if (!plugin) return;
  await plugin.setMode({ mode });
}

/**
 * Auto-start support for the in-chat onboarding wrap-up: detects whether the
 * current platform can launch Eliza automatically (desktop login item /
 * Android boot receiver) and performs the enable write when the user opts in.
 *
 * Consumed by `use-first-run-conductor.ts`, which seeds the auto-start CHOICE
 * turn only when `detectAutostartPlatform()` reports support. Two platforms
 * qualify:
 *  - **desktop** (Electrobun shell) — routed over the same
 *    `desktopSetAutoLaunch` RPC the Settings toggle uses
 *    (`DesktopWorkspaceSection`), which writes the real OS artifact (macOS
 *    LaunchAgent plist / Linux autostart .desktop / Windows HKCU Run key) in
 *    `platforms/electrobun/src/native/desktop.ts`.
 *  - **android** (native Capacitor shell) — writes the Capacitor preference
 *    `ElizaBootReceiver` gates on. Capacitor Preferences stores booleans as the
 *    STRINGS "true"/"false"; the receiver accepts both forms and defaults to
 *    enabled when the key is absent, so the explicit write here records the
 *    user's affirmative choice.
 *
 * Web and iOS have no app-controlled auto-start, so detection returns null and
 * the onboarding step never renders there. `enableAutostart` never rejects: it
 * translates every failure into a typed result the conductor renders as a
 * non-blocking notice turn, and it is replay-safe — a dev onboarding replay
 * (`?onboarding-replay=1`, #14382) skips the persistent write entirely.
 */

import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { isOnboardingReplayRequested } from "../platform/onboarding-replay";
import { getFrontendPlatform } from "../platform/platform-guards";

/** Platforms whose shells support launching Eliza automatically. */
export type AutostartPlatform = "desktop" | "android";

/**
 * The Capacitor Preferences key `ElizaBootReceiver` reads before re-enqueueing
 * background work on BOOT_COMPLETED. Keep in sync with
 * `platforms/android/.../ElizaBootReceiver.java` (`BACKGROUND_ENABLED_KEY`).
 */
export const ANDROID_BACKGROUND_ENABLED_PREF_KEY = "eliza:background-enabled";

export type AutostartEnableResult =
  | { status: "enabled" }
  /** Onboarding replay (#14382) — the real write was deliberately skipped. */
  | { status: "replay-skipped" }
  | { status: "failed"; message: string };

/**
 * Which auto-start mechanism the current shell supports, or null when none
 * does (web, iOS). Call-time detection via the same canonical guard the
 * permission-priming sets use (`getFrontendPlatform`), so a desktop renderer
 * qualifies the moment the Electrobun bridge is injected.
 */
export function detectAutostartPlatform(): AutostartPlatform | null {
  const platform = getFrontendPlatform();
  if (platform === "desktop") return "desktop";
  if (platform === "android") return "android";
  return null;
}

/**
 * Perform the platform's auto-start enable write. Never rejects — the caller
 * (the onboarding conductor) must proceed either way, so every failure comes
 * back as a typed `failed` result with a human-readable message.
 */
export async function enableAutostart(
  platform: AutostartPlatform,
): Promise<AutostartEnableResult> {
  // Replay mode re-runs onboarding as a non-destructive overlay on a real
  // agent — no persistent side effects may leak (same guard the completion
  // seeding uses in useFirstRunState).
  if (isOnboardingReplayRequested()) {
    return { status: "replay-skipped" };
  }
  try {
    if (platform === "desktop") {
      const result = await invokeDesktopBridgeRequest<void>({
        rpcMethod: "desktopSetAutoLaunch",
        ipcChannel: "desktop:setAutoLaunch",
        params: { enabled: true, openAsHidden: false },
      });
      // The bridge helper resolves `null` (not undefined) when the RPC method
      // is absent — a stale widget in a non-desktop shell, or a broken preload.
      // That is a failure to surface, not a silent success.
      if (result === null) {
        return {
          status: "failed",
          message: "The desktop bridge is unavailable.",
        };
      }
      return { status: "enabled" };
    }
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.set({
      key: ANDROID_BACKGROUND_ENABLED_PREF_KEY,
      value: "true",
    });
    return { status: "enabled" };
  } catch (err) {
    // error-policy:J1 boundary translation — the RPC/Preferences rejection is
    // turned into a structured failure the conductor renders as a notice turn;
    // onboarding proceeds either way.
    return {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

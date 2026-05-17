/**
 * Microphone prober.
 *
 * Native APIs (macOS):
 *   - check:   AVCaptureDevice.authorizationStatus(for: .audio)
 *   - request: AVCaptureDevice.requestAccess(for: .audio)
 *
 * Cross-platform: on win32/linux the renderer supplies browser/device state
 * through `navigator.permissions.query({ name: 'microphone' })` and
 * getUserMedia.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  getNativeDylib,
  IS_DARWIN,
  mapAVAuthStatus,
  openPrivacyPane,
} from "./_bridge.js";

const ID = "microphone" as const;

export const microphoneProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) {
      // Renderer fallback handles navigator.permissions/getUserMedia.
      return buildState(ID, "not-determined", { canRequest: true });
    }

    const lib = await getNativeDylib();
    const status = mapAVAuthStatus(lib?.checkMicrophonePermission() ?? 0);
    return buildState(ID, status, {
      canRequest: status === "not-determined",
    });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) {
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const lib = await getNativeDylib();
    lib?.requestMicrophonePermission();
    const state = await microphoneProber.check();
    // If the OS denied without prompting (TCC has prior denial), open
    // the privacy pane so the user can toggle it on.
    if (state.status === "denied") {
      await openPrivacyPane("Microphone");
    }
    return { ...state, lastRequested: Date.now() };
  },
};

/**
 * Camera prober.
 *
 * Native APIs (macOS):
 *   - check:   AVCaptureDevice.authorizationStatus(for: .video)
 *   - request: AVCaptureDevice.requestAccess(for: .video)
 *
 * On win32/linux, the renderer supplies the concrete browser/device state
 * through navigator.permissions/getUserMedia and writes it back through the
 * shared permission routes.
 */

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  getNativeDylib,
  IS_DARWIN,
  mapAVAuthStatus,
  openPrivacyPane,
} from "./_bridge.js";

const ID = "camera" as const;

export const cameraProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) {
      // Renderer fallback handles navigator.permissions/getUserMedia.
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const lib = await getNativeDylib();
    const status = mapAVAuthStatus(lib?.checkCameraPermission() ?? 0);
    return buildState(ID, status, {
      canRequest: status === "not-determined",
    });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) {
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const lib = await getNativeDylib();
    lib?.requestCameraPermission();
    const state = await cameraProber.check();
    if (state.status === "denied") {
      await openPrivacyPane("Camera");
    }
    return { ...state, lastRequested: Date.now() };
  },
};

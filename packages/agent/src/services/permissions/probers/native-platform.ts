/**
 * Probers for the permission ids that only carry meaning on native mobile
 * platforms (speech-recognition, photos, phone, messages, wifi, bluetooth,
 * usage-access, overlay, and the like). On this desktop host each one resolves
 * to a platform-unsupported state for both check() and request(), so the
 * registry reports them uniformly instead of leaving them unregistered.
 */
import type { PermissionId, Prober } from "../contracts.js";
import { platformUnsupportedState } from "./_bridge.js";

const NATIVE_PLATFORM_IDS = [
  "speech-recognition",
  "photos",
  "phone",
  "messages",
  "wifi",
  "bluetooth",
  "app-blocking",
  "usage-access",
  "overlay",
  "write-settings",
  "local-network",
  "battery-optimization",
] as const satisfies readonly PermissionId[];

function nativePlatformProber(id: PermissionId): Prober {
  return {
    id,
    async check() {
      return platformUnsupportedState(id);
    },
    async request() {
      return platformUnsupportedState(id);
    },
  };
}

export const nativePlatformProbers: readonly Prober[] =
  NATIVE_PLATFORM_IDS.map(nativePlatformProber);

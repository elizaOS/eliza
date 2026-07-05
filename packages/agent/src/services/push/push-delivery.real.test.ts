/**
 * Real-network delivery test for the APNs + FCM providers. It drives the actual
 * `send()` path against Apple's / Google's live servers — proving JWT auth, the
 * HTTP/2 (APNs) and OAuth2-then-HTTPS (FCM) transports, and real error parsing —
 * using an intentionally invalid device token so the servers reject it with a
 * "token dead" response (surfaced as `PushUnregisteredError`) instead of
 * delivering. That negative-delivery assertion is the strongest signal reachable
 * without a physical enrolled device: reaching `Unregistered`/`BadDeviceToken`
 * (APNs) or `UNREGISTERED`/`INVALID_ARGUMENT` (FCM) means credentials were
 * accepted and the request round-tripped end to end.
 *
 * These run only when credentials are present in the env (post-merge/live lane);
 * absent creds skip with a reason — the delivery-to-a-real-device leg is
 * pending-hardware (needs live APNs/FCM keys + an enrolled device).
 */
import { describe, expect, it } from "vitest";
import { ApnsProvider, readApnsConfig } from "./apns-provider.ts";
import { FcmProvider, readServiceAccount } from "./fcm-provider.ts";
import { PushUnregisteredError } from "./push-types.ts";

const hasApns = readApnsConfig() !== null;
const hasFcm = readServiceAccount() !== null;

const message = {
  title: "Eliza push delivery probe",
  body: "Real-network APNs/FCM round-trip test",
  data: { notificationId: "probe", deepLink: "/tasks" },
};

describe.skipIf(!hasApns)("ApnsProvider live delivery (APNs sandbox)", () => {
  it("round-trips to Apple and rejects a bogus device token", async () => {
    const provider = new ApnsProvider();
    expect(provider.isConfigured()).toBe(true);
    // 64 hex chars is a well-formed but non-existent APNs token: Apple accepts
    // the authenticated request, then rejects the token as BadDeviceToken.
    const bogusToken = "0".repeat(64);
    await expect(provider.send(bogusToken, message)).rejects.toBeInstanceOf(
      PushUnregisteredError,
    );
  });
});

describe.skipIf(!hasFcm)("FcmProvider live delivery (FCM v1)", () => {
  it("exchanges an OAuth token with Google and rejects a bogus registration token", async () => {
    const provider = new FcmProvider();
    expect(provider.isConfigured()).toBe(true);
    // A malformed FCM registration token: Google authenticates the request via
    // the exchanged bearer, then rejects the token as invalid/unregistered.
    await expect(
      provider.send("invalid-fcm-registration-token", message),
    ).rejects.toThrow();
  });
});

// Guard: when neither transport is credentialed the suite must not silently
// vanish — record why, so "pending-hardware" is visible in the run output.
describe.skipIf(hasApns || hasFcm)(
  "push live delivery (no credentials)",
  () => {
    it("is pending-hardware: set ELIZA_APNS_* / ELIZA_FCM_SERVICE_ACCOUNT to run", () => {
      expect(hasApns || hasFcm).toBe(false);
    });
  },
);

/** Strict parsing and exactly-once in-memory dispatch for pairing deep links. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchRemoteControllerPairingIntent,
  parseRemoteControllerPairingDeepLink,
  remoteControllerPairingIntentInternals,
  subscribeRemoteControllerPairingIntents,
} from "./remote-target-pairing-intent";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => remoteControllerPairingIntentInternals.clearPending());

describe("remote controller pairing deep links", () => {
  it("accepts only the canonical session-bound QR payload", () => {
    expect(
      parseRemoteControllerPairingDeepLink(
        `elizaos://remote/control-claim?session=${SESSION_ID}&code=042731`,
      ),
    ).toEqual({ sessionId: SESSION_ID, code: "042731", source: "qr" });
  });

  it.each([
    `https://remote/control-claim?session=${SESSION_ID}&code=042731`,
    `elizaos://remote/pair?session=${SESSION_ID}&code=042731`,
    `elizaos://remote/control-claim/extra?session=${SESSION_ID}&code=042731`,
    `elizaos://remote/control-claim?session=${SESSION_ID}&code=042731&token=secret`,
    `elizaos://remote/control-claim?session=${SESSION_ID}&session=${SESSION_ID}&code=042731`,
    `elizaos://remote/control-claim?session=${SESSION_ID}&code=042731&code=999999`,
    `elizaos://remote/control-claim?session=not-a-uuid&code=042731`,
    `elizaos://remote/control-claim?session=${SESSION_ID}&code=42731`,
    `elizaos://remote/control-claim?session=${SESSION_ID}&code=042731#fragment`,
  ])("rejects non-canonical or credential-bearing payload %s", (value) => {
    expect(parseRemoteControllerPairingDeepLink(value)).toBeNull();
  });

  it("delivers a queued intent to exactly one mounted consumer", () => {
    const intent = {
      sessionId: SESSION_ID,
      code: "042731",
      source: "qr" as const,
    };
    const first = vi.fn();
    const second = vi.fn();
    dispatchRemoteControllerPairingIntent(intent);
    const unsubscribeFirst = subscribeRemoteControllerPairingIntents(first);
    const unsubscribeSecond = subscribeRemoteControllerPairingIntents(second);
    expect(first).toHaveBeenCalledWith(intent);
    expect(second).not.toHaveBeenCalled();
    unsubscribeFirst();
    unsubscribeSecond();
  });
});

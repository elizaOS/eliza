/** Strict parsing and exactly-once in-memory dispatch for pairing deep links. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchRemoteTargetPairingIntent,
  parseRemoteTargetPairingDeepLink,
  remoteTargetPairingIntentInternals,
  subscribeRemoteTargetPairingIntents,
} from "./remote-target-pairing-intent";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => remoteTargetPairingIntentInternals.clearPending());

describe("remote target pairing deep links", () => {
  it("accepts only the canonical session-bound QR payload", () => {
    expect(
      parseRemoteTargetPairingDeepLink(
        `elizaos://remote/pair?session=${SESSION_ID}&code=042731`,
      ),
    ).toEqual({ sessionId: SESSION_ID, code: "042731", source: "qr" });
  });

  it.each([
    `https://remote/pair?session=${SESSION_ID}&code=042731`,
    `elizaos://remote/pair/extra?session=${SESSION_ID}&code=042731`,
    `elizaos://remote/pair?session=${SESSION_ID}&code=042731&token=secret`,
    `elizaos://remote/pair?session=${SESSION_ID}&session=${SESSION_ID}&code=042731`,
    `elizaos://remote/pair?session=${SESSION_ID}&code=042731&code=999999`,
    `elizaos://remote/pair?session=not-a-uuid&code=042731`,
    `elizaos://remote/pair?session=${SESSION_ID}&code=42731`,
    `elizaos://remote/pair?session=${SESSION_ID}&code=042731#fragment`,
  ])("rejects non-canonical or credential-bearing payload %s", (value) => {
    expect(parseRemoteTargetPairingDeepLink(value)).toBeNull();
  });

  it("delivers a queued intent to exactly one mounted consumer", () => {
    const intent = {
      sessionId: SESSION_ID,
      code: "042731",
      source: "qr" as const,
    };
    const first = vi.fn();
    const second = vi.fn();
    dispatchRemoteTargetPairingIntent(intent);
    const unsubscribeFirst = subscribeRemoteTargetPairingIntents(first);
    const unsubscribeSecond = subscribeRemoteTargetPairingIntents(second);
    expect(first).toHaveBeenCalledWith(intent);
    expect(second).not.toHaveBeenCalled();
    unsubscribeFirst();
    unsubscribeSecond();
  });
});

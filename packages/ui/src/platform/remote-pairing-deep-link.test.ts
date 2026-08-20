import { describe, expect, it } from "vitest";
import {
  clearPendingRemotePairingCode,
  peekPendingRemotePairingCode,
  queueRemotePairingDeepLink,
  takePendingRemotePairingCode,
} from "./remote-pairing-deep-link";

describe("remote pairing QR deep links", () => {
  it("keeps a valid one-time code in memory until Settings consumes it", () => {
    expect(
      queueRemotePairingDeepLink(
        "elizaos://pair?session=23766030-0000-0000-0000-000000000000&code=482731",
      ),
    ).toBe(true);
    expect(takePendingRemotePairingCode()).toBe("482731");
    expect(takePendingRemotePairingCode()).toBeNull();
  });

  it("rejects malformed schemes, sessions, and codes", () => {
    expect(
      queueRemotePairingDeepLink("https://evil.example/pair?code=482731"),
    ).toBe(false);
    expect(queueRemotePairingDeepLink("elizaos://pair?code=123")).toBe(false);
    expect(
      queueRemotePairingDeepLink("elizaos://pair?session=bad&code=482731"),
    ).toBe(false);
  });

  it("keeps a code queued through auth and clears only the redeemed value", () => {
    expect(queueRemotePairingDeepLink("elizaos://pair?code=482731")).toBe(true);
    expect(peekPendingRemotePairingCode()).toBe("482731");
    expect(peekPendingRemotePairingCode()).toBe("482731");
    expect(clearPendingRemotePairingCode("111111")).toBe(false);
    expect(peekPendingRemotePairingCode()).toBe("482731");
    expect(clearPendingRemotePairingCode("482731")).toBe(true);
    expect(peekPendingRemotePairingCode()).toBeNull();
  });
});

/** Exact-target deep-link replay preserves a paired device without trusting link credentials. */
import { describe, expect, it } from "vitest";
import { isAlreadyPairedRemoteTarget } from "../remote-deep-link-connection";

describe("remote deep-link replay", () => {
  const target = new URL("http://10.0.0.241:31725/");

  it("keeps a paired session only for the exact persisted target", () => {
    expect(
      isAlreadyPairedRemoteTarget(target, {
        kind: "remote",
        apiBase: "http://10.0.0.241:31725",
        accessToken: "paired-machine-session",
      }),
    ).toBe(true);
    expect(
      isAlreadyPairedRemoteTarget(new URL("http://10.0.0.242:31725/"), {
        kind: "remote",
        apiBase: "http://10.0.0.241:31725",
        accessToken: "paired-machine-session",
      }),
    ).toBe(false);
    expect(
      isAlreadyPairedRemoteTarget(new URL("http://10.0.0.241:31726/"), {
        kind: "remote",
        apiBase: "http://10.0.0.241:31725",
        accessToken: "paired-machine-session",
      }),
    ).toBe(false);
  });

  it("does not skip first pairing, a revoked token, or a different runtime", () => {
    expect(isAlreadyPairedRemoteTarget(target, null)).toBe(false);
    expect(
      isAlreadyPairedRemoteTarget(target, {
        kind: "remote",
        apiBase: target.href,
      }),
    ).toBe(false);
    expect(
      isAlreadyPairedRemoteTarget(target, {
        kind: "cloud",
        apiBase: target.href,
        accessToken: "other-authority",
      }),
    ).toBe(false);
  });
});

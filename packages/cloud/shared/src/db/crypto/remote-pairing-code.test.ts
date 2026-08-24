/**
 * Covers the keyed verifier stored in place of a human-entered remote pairing
 * code. The verifier is what stands between a six-digit code and remote control
 * of an agent or host, so the properties worth pinning are the negative ones:
 * every identity in the context is bound into the signature, the signed expiry
 * cannot be edited in the stored string, and an agent verifier (v2) must never
 * satisfy a host context (v3) or vice versa.
 *
 * Drives the real exported derive/verify pair over real WebCrypto HMAC — no
 * stubbed subtle crypto, no database.
 */
import { describe, expect, test } from "bun:test";

import {
  deriveRemotePairingCodeVerifier,
  isRemotePairingSessionCurrent,
  isRemotePairingUuid,
  isRemotePairingVerifierCurrent,
  type RemotePairingVerifierContext,
  remotePairingVerifierExpiryMs,
  verifyRemotePairingCodeVerifier,
} from "./remote-pairing-code";

const SECRET = "0123456789abcdef0123456789abcdef";
const ORG = "11111111-2222-4333-8444-555555555555";
const USER = "22222222-3333-4444-8555-666666666666";
const SESSION = "33333333-4444-4555-8666-777777777777";
const AGENT = "44444444-5555-4666-8777-888888888888";
const HOST = "55555555-6666-4777-8888-999999999999";
const CODE = "123456";
const NOW_MS = 1_800_000_000_000;
const EXPIRES = new Date(NOW_MS + 600_000);
const NOW = new Date(NOW_MS);

const agentCtx: RemotePairingVerifierContext = {
  organizationId: ORG,
  userId: USER,
  sessionId: SESSION,
  agentId: AGENT,
};
const hostCtx: RemotePairingVerifierContext = {
  organizationId: ORG,
  userId: USER,
  sessionId: SESSION,
  hostId: HOST,
};

describe("isRemotePairingUuid", () => {
  test("accepts canonical UUIDs and rejects near-misses", () => {
    expect(isRemotePairingUuid(ORG)).toBe(true);
    // The pattern is lowercase-only, so an uppercase-hex UUID is not canonical.
    const withHexLetters = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(isRemotePairingUuid(withHexLetters)).toBe(true);
    expect(isRemotePairingUuid(withHexLetters.toUpperCase())).toBe(false);
    expect(isRemotePairingUuid("not-a-uuid")).toBe(false);
    expect(isRemotePairingUuid(`${ORG} `)).toBe(false);
    expect(isRemotePairingUuid("")).toBe(false);
  });
});

describe("deriveRemotePairingCodeVerifier", () => {
  test("emits the versioned prefix matching the bound target", async () => {
    const agent = await deriveRemotePairingCodeVerifier(SECRET, agentCtx, CODE, EXPIRES);
    const host = await deriveRemotePairingCodeVerifier(SECRET, hostCtx, CODE, EXPIRES);
    expect(agent.startsWith("hmac-sha256-v2:")).toBe(true);
    expect(host.startsWith("hmac-sha256-v3:")).toBe(true);
    expect(agent).not.toBe(host);
  });

  test("carries the signed expiry in the stored string", async () => {
    const verifier = await deriveRemotePairingCodeVerifier(SECRET, agentCtx, CODE, EXPIRES);
    expect(remotePairingVerifierExpiryMs(verifier)).toBe(EXPIRES.getTime());
  });

  test("requires exactly one bound target", async () => {
    const neither = { organizationId: ORG, userId: USER, sessionId: SESSION };
    const both = { ...agentCtx, hostId: HOST };
    expect(deriveRemotePairingCodeVerifier(SECRET, neither, CODE, EXPIRES)).rejects.toThrow();
    expect(deriveRemotePairingCodeVerifier(SECRET, both, CODE, EXPIRES)).rejects.toThrow();
  });

  test("rejects a secret shorter than 32 bytes", async () => {
    expect(deriveRemotePairingCodeVerifier("tooshort", agentCtx, CODE, EXPIRES)).rejects.toThrow();
  });

  test("rejects a code that is not exactly six digits", async () => {
    for (const code of ["12345", "1234567", "12345a", "", " 123456"]) {
      expect(deriveRemotePairingCodeVerifier(SECRET, agentCtx, code, EXPIRES)).rejects.toThrow();
    }
  });

  test("rejects a non-UUID identity anywhere in the context", async () => {
    for (const key of ["organizationId", "userId", "sessionId", "agentId"] as const) {
      const broken = { ...agentCtx, [key]: "nope" };
      expect(deriveRemotePairingCodeVerifier(SECRET, broken, CODE, EXPIRES)).rejects.toThrow();
    }
  });
});

describe("verifyRemotePairingCodeVerifier", () => {
  const derive = (ctx = agentCtx, code = CODE) =>
    deriveRemotePairingCodeVerifier(SECRET, ctx, code, EXPIRES);

  test("accepts the code it was derived from", async () => {
    expect(await verifyRemotePairingCodeVerifier(SECRET, agentCtx, CODE, await derive(), NOW)).toBe(
      true,
    );
  });

  test("rejects a different code", async () => {
    expect(
      await verifyRemotePairingCodeVerifier(SECRET, agentCtx, "654321", await derive(), NOW),
    ).toBe(false);
  });

  test("rejects a different secret", async () => {
    expect(
      await verifyRemotePairingCodeVerifier(
        "fedcba9876543210fedcba9876543210",
        agentCtx,
        CODE,
        await derive(),
        NOW,
      ),
    ).toBe(false);
  });

  test("binds every identity in the context", async () => {
    const verifier = await derive();
    const swaps: Array<Partial<RemotePairingVerifierContext>> = [
      { organizationId: "66666666-7777-4888-8999-aaaaaaaaaaaa" },
      { userId: "66666666-7777-4888-8999-aaaaaaaaaaaa" },
      { sessionId: "66666666-7777-4888-8999-aaaaaaaaaaaa" },
      { agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa" },
    ];
    for (const swap of swaps) {
      expect(
        await verifyRemotePairingCodeVerifier(
          SECRET,
          { ...agentCtx, ...swap },
          CODE,
          verifier,
          NOW,
        ),
      ).toBe(false);
    }
  });

  test("refuses to satisfy a host context with an agent verifier, and the reverse", async () => {
    // The version nibble is the agent/host discriminator; crossing it would let
    // a pairing minted for one target authorize the other.
    const agentVerifier = await derive(agentCtx);
    const hostVerifier = await derive(hostCtx);
    expect(await verifyRemotePairingCodeVerifier(SECRET, hostCtx, CODE, agentVerifier, NOW)).toBe(
      false,
    );
    expect(await verifyRemotePairingCodeVerifier(SECRET, agentCtx, CODE, hostVerifier, NOW)).toBe(
      false,
    );
    expect(await verifyRemotePairingCodeVerifier(SECRET, hostCtx, CODE, hostVerifier, NOW)).toBe(
      true,
    );
  });

  test("rejects an expired verifier, including one expiring exactly now", async () => {
    const verifier = await derive();
    expect(
      await verifyRemotePairingCodeVerifier(
        SECRET,
        agentCtx,
        CODE,
        verifier,
        new Date(EXPIRES.getTime()),
      ),
    ).toBe(false);
    expect(
      await verifyRemotePairingCodeVerifier(
        SECRET,
        agentCtx,
        CODE,
        verifier,
        new Date(EXPIRES.getTime() + 1),
      ),
    ).toBe(false);
  });

  test("rejects a verifier whose expiry slot was edited", async () => {
    // The expiry is inside the signed payload, so extending it in the stored
    // string cannot buy more time.
    const verifier = await derive();
    const [prefix, , signature] = verifier.split(":");
    const extended = `${prefix}:${EXPIRES.getTime() + 600_000}:${signature}`;
    expect(await verifyRemotePairingCodeVerifier(SECRET, agentCtx, CODE, extended, NOW)).toBe(
      false,
    );
  });

  test("never throws on a malformed verifier", async () => {
    for (const verifier of [
      "",
      "garbage",
      "hmac-sha256-v2",
      "hmac-sha256-v2:123:abc",
      `hmac-sha256-v9:${NOW_MS}:${"a".repeat(64)}`,
      `hmac-sha256-v2:${NOW_MS}:${"z".repeat(64)}`,
      `hmac-sha256-v2:${NOW_MS}:${"a".repeat(63)}`,
    ]) {
      expect(await verifyRemotePairingCodeVerifier(SECRET, agentCtx, CODE, verifier, NOW)).toBe(
        false,
      );
    }
  });
});

describe("verifier currency helpers", () => {
  test("parses a structurally valid expiry and rejects malformed input", () => {
    expect(remotePairingVerifierExpiryMs(null)).toBeNull();
    expect(remotePairingVerifierExpiryMs("garbage")).toBeNull();
    expect(remotePairingVerifierExpiryMs(`hmac-sha256-v2:${NOW_MS}:${"a".repeat(64)}`)).toBe(
      NOW_MS,
    );
  });

  test("treats an expiry at exactly now as no longer current", () => {
    const verifier = `hmac-sha256-v2:${NOW_MS}:${"a".repeat(64)}`;
    expect(isRemotePairingVerifierCurrent(verifier, NOW_MS - 1)).toBe(true);
    expect(isRemotePairingVerifierCurrent(verifier, NOW_MS)).toBe(false);
    expect(isRemotePairingVerifierCurrent(null, NOW_MS)).toBe(false);
  });

  test("keeps active sessions current regardless of verifier, and gates pending ones", () => {
    const live = `hmac-sha256-v2:${NOW_MS}:${"a".repeat(64)}`;
    expect(isRemotePairingSessionCurrent("active", null, NOW_MS)).toBe(true);
    expect(isRemotePairingSessionCurrent("pending", live, NOW_MS - 1)).toBe(true);
    expect(isRemotePairingSessionCurrent("pending", live, NOW_MS)).toBe(false);
    expect(isRemotePairingSessionCurrent("pending", null, NOW_MS - 1)).toBe(false);
    for (const status of ["denied", "revoked", "expired"] as const) {
      expect(isRemotePairingSessionCurrent(status, live, NOW_MS - 1)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import { authenticateBrowserBridgeCompanionCredential } from "./companion-auth.js";

const NOW_MS = Date.parse("2026-05-08T12:00:00.000Z");

describe("Browser Bridge companion bearer auth", () => {
  it("accepts a valid companion bearer token", () => {
    expect(
      authenticateBrowserBridgeCompanionCredential({
        credential: {
          companion: {
            pairingTokenExpiresAt: "2026-06-07T12:00:00.000Z",
            pairingTokenRevokedAt: null,
          },
          pairingTokenHash: "active-token-hash",
          pendingPairingTokens: [],
        },
        pairingTokenHash: "active-token-hash",
        nowMs: NOW_MS,
      }),
    ).toMatchObject({
      ok: true,
      source: "active",
      expiresAt: "2026-06-07T12:00:00.000Z",
    });
  });

  it("accepts a pending rotation token and returns the remaining pending set", () => {
    expect(
      authenticateBrowserBridgeCompanionCredential({
        credential: {
          companion: {
            pairingTokenExpiresAt: "2026-06-07T12:00:00.000Z",
            pairingTokenRevokedAt: null,
          },
          pairingTokenHash: "active-token-hash",
          pendingPairingTokens: [
            { hash: "pending-a", expiresAt: "2026-05-09T12:00:00.000Z" },
            { hash: "pending-b", expiresAt: "2026-05-10T12:00:00.000Z" },
          ],
        },
        pairingTokenHash: "pending-a",
        nowMs: NOW_MS,
      }),
    ).toEqual({
      ok: true,
      source: "pending",
      expiresAt: "2026-05-09T12:00:00.000Z",
      remainingPendingPairingTokens: [
        { hash: "pending-b", expiresAt: "2026-05-10T12:00:00.000Z" },
      ],
    });
  });

  it("rejects an expired companion bearer token", () => {
    expect(
      authenticateBrowserBridgeCompanionCredential({
        credential: {
          companion: {
            pairingTokenExpiresAt: "2026-05-08T11:59:59.000Z",
            pairingTokenRevokedAt: null,
          },
          pairingTokenHash: "active-token-hash",
          pendingPairingTokens: [],
        },
        pairingTokenHash: "active-token-hash",
        nowMs: NOW_MS,
      }),
    ).toEqual({
      ok: false,
      code: "browser_bridge_companion_token_expired",
      message: "browser companion pairing token is expired",
    });
  });

  it("rejects a revoked companion bearer token", () => {
    expect(
      authenticateBrowserBridgeCompanionCredential({
        credential: {
          companion: {
            pairingTokenExpiresAt: "2026-06-07T12:00:00.000Z",
            pairingTokenRevokedAt: "2026-05-08T12:00:00.000Z",
          },
          pairingTokenHash: "active-token-hash",
          pendingPairingTokens: [],
        },
        pairingTokenHash: "active-token-hash",
        nowMs: NOW_MS,
      }),
    ).toEqual({
      ok: false,
      code: "browser_bridge_companion_token_revoked",
      message: "browser companion pairing token is revoked",
    });
  });
});

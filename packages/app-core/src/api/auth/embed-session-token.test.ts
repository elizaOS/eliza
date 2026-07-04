import { describe, expect, it } from "vitest";
import {
  EMBED_ELEVATED_ROLES,
  type EmbedSessionClaims,
  isEmbedRole,
  mintEmbedSessionToken,
  verifyEmbedSessionToken,
} from "./embed-session-token";

const SECRET = "embed-secret-at-least-16-chars-long";

function claims(
  overrides: Partial<EmbedSessionClaims> = {},
): EmbedSessionClaims {
  return {
    entityId: "11111111-1111-1111-1111-111111111111",
    role: "OWNER",
    adminMode: true,
    exp: 1_000_000,
    ...overrides,
  };
}

describe("embed session token", () => {
  it("round-trips a valid token", () => {
    const token = mintEmbedSessionToken(claims(), SECRET);
    const decoded = verifyEmbedSessionToken(token, SECRET, 0);
    expect(decoded).toMatchObject({
      entityId: "11111111-1111-1111-1111-111111111111",
      role: "OWNER",
      adminMode: true,
    });
  });

  it("rejects a token signed with a different secret (fail closed)", () => {
    const token = mintEmbedSessionToken(claims(), SECRET);
    expect(
      verifyEmbedSessionToken(token, "another-secret-16chars", 0),
    ).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = mintEmbedSessionToken(claims({ role: "ADMIN" }), SECRET);
    const forged = mintEmbedSessionToken(claims({ role: "OWNER" }), SECRET);
    // splice the OWNER payload onto the ADMIN signature → signature mismatch
    const tampered = `${forged.split(".")[0]}.${token.split(".")[1]}`;
    expect(verifyEmbedSessionToken(tampered, SECRET, 0)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = mintEmbedSessionToken(claims({ exp: 1000 }), SECRET);
    expect(verifyEmbedSessionToken(token, SECRET, 999)).not.toBeNull();
    expect(verifyEmbedSessionToken(token, SECRET, 1000)).toBeNull();
    expect(verifyEmbedSessionToken(token, SECRET, 2000)).toBeNull();
  });

  it("rejects malformed / empty tokens and missing secret", () => {
    expect(verifyEmbedSessionToken("", SECRET)).toBeNull();
    expect(verifyEmbedSessionToken("nodot", SECRET)).toBeNull();
    expect(verifyEmbedSessionToken("a.b.c", SECRET)).toBeNull();
    expect(
      verifyEmbedSessionToken(mintEmbedSessionToken(claims(), SECRET), ""),
    ).toBeNull();
  });

  it("refuses to mint without a secret", () => {
    expect(() => mintEmbedSessionToken(claims(), "")).toThrow();
  });
});

describe("isEmbedRole / EMBED_ELEVATED_ROLES (#12087 Item 30)", () => {
  it("accepts exactly the elevated roles", () => {
    expect(EMBED_ELEVATED_ROLES).toEqual(["OWNER", "ADMIN"]);
    for (const role of EMBED_ELEVATED_ROLES) {
      expect(isEmbedRole(role)).toBe(true);
    }
  });

  it("rejects non-elevated roles and non-strings (fails closed)", () => {
    for (const value of ["USER", "GUEST", "NONE", "owner", "", null, 1, {}]) {
      expect(isEmbedRole(value)).toBe(false);
    }
  });
});

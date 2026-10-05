import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  mintEmbedSessionToken,
  verifyEmbedSessionToken,
} from "./embed-session-token";

const secret = "embed-token-regression-secret";
const claims = {
  entityId: "entity-1",
  role: "OWNER" as const,
  adminMode: true,
  exp: 2000,
};
function signed(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

describe("embed session claim validation", () => {
  it("preserves verified claims and rejects expiry and tampering", () => {
    const token = mintEmbedSessionToken(claims, secret);
    expect(verifyEmbedSessionToken(token, secret, 1000)).toEqual(claims);
    expect(verifyEmbedSessionToken(token, secret, 2000)).toBeNull();
    expect(verifyEmbedSessionToken(`${token}x`, secret, 1000)).toBeNull();
  });
  it.each([
    null,
    false,
    [],
    "claims",
    {},
    { ...claims, entityId: "" },
    { ...claims, adminMode: undefined },
    { ...claims, adminMode: "true" },
    { ...claims, role: "USER" },
    { ...claims, exp: null },
  ])("rejects malformed signed payload %# without throwing", (payload) => {
    expect(verifyEmbedSessionToken(signed(payload), secret, 1000)).toBeNull();
  });
});

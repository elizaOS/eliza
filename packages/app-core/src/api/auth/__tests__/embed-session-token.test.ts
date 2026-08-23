import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBED_TOKEN_TTL_MS,
  EMBED_SESSION_SECRET_MIN_LENGTH,
  isEmbedRole,
  mintEmbedSessionToken,
  readEmbedSessionSecretSetting,
  resolveEmbedSessionSecret,
  resolveEmbedSessionSecretForRuntime,
  verifyEmbedSessionToken,
} from "./embed-session-token.ts";

describe("isEmbedRole", () => {
  it("accepts only the elevated role set", () => {
    expect(isEmbedRole("OWNER")).toBe(true);
    expect(isEmbedRole("ADMIN")).toBe(true);
    expect(isEmbedRole("MEMBER")).toBe(false);
    expect(isEmbedRole(undefined)).toBe(false);
    expect(isEmbedRole(42)).toBe(false);
  });
});

describe("resolveEmbedSessionSecret", () => {
  it("returns the first key with a sufficiently long value", () => {
    const read = (k: string) =>
      k === "ELIZA_EMBED_SESSION_SECRET" ? "a".repeat(20) : "b".repeat(20);
    expect(resolveEmbedSessionSecret(read)).toBe("a".repeat(20));
  });

  it("returns null when all values are too short", () => {
    const read = () => "short";
    expect(resolveEmbedSessionSecret(read)).toBeNull();
  });

  it("prefers runtime settings over env", () => {
    const runtime = { getSetting: () => "r".repeat(20) };
    expect(
      readEmbedSessionSecretSetting(runtime, "K", { K: "e".repeat(20) }),
    ).toBe("r".repeat(20));
    expect(
      readEmbedSessionSecretSetting(null, "K", { K: "e".repeat(20) }),
    ).toBe("e".repeat(20));
    expect(resolveEmbedSessionSecretForRuntime(runtime, {})).toBe(
      "r".repeat(20),
    );
    expect(resolveEmbedSessionSecretForRuntime(null, {})).toBeNull();
  });
});

describe("embed token mint/verify", () => {
  const secret = "s".repeat(EMBED_SESSION_SECRET_MIN_LENGTH);
  const claims = {
    entityId: "e1",
    role: "OWNER" as const,
    adminMode: false,
    exp: Date.now() + DEFAULT_EMBED_TOKEN_TTL_MS,
  };

  it("mints and verifies a round-trip token", () => {
    const token = mintEmbedSessionToken(claims, secret);
    expect(verifyEmbedSessionToken(token, secret)).toEqual(claims);
  });

  it("rejects a tampered payload", () => {
    const token = mintEmbedSessionToken(claims, secret);
    const [payload, sig] = token.split(".");
    const tampered = `${Buffer.from("tampered").toString("base64url")}.${sig}`;
    expect(verifyEmbedSessionToken(tampered, secret)).toBeNull();
  });

  it("rejects a wrong-secret signature", () => {
    const token = mintEmbedSessionToken(claims, secret);
    expect(verifyEmbedSessionToken(token, "x".repeat(20))).toBeNull();
  });

  it("rejects an expired token", () => {
    const expired = { ...claims, exp: Date.now() - 1000 };
    const token = mintEmbedSessionToken(expired, secret);
    expect(verifyEmbedSessionToken(token, secret)).toBeNull();
  });

  it("mint throws on empty secret", () => {
    expect(() => mintEmbedSessionToken(claims, "")).toThrow(
      "secret is required",
    );
  });
});

import { describe, expect, it } from "vitest";
import { normalizePreflightAuth } from "./coding-agents-preflight-normalize.js";

describe("normalizePreflightAuth", () => {
  it("preserves known auth statuses and whitelisted display fields", () => {
    expect(
      normalizePreflightAuth({
        status: "unauthenticated",
        method: "oauth-device-code",
        detail: "GitHub login required",
        loginHint: "owner@example.com",
        accessToken: "secret",
      }),
    ).toEqual({
      status: "unauthenticated",
      method: "oauth-device-code",
      detail: "GitHub login required",
      loginHint: "owner@example.com",
    });
  });

  it("normalizes unknown and missing statuses to unknown", () => {
    expect(normalizePreflightAuth({ status: "expired" })).toEqual({
      status: "unknown",
    });
    expect(normalizePreflightAuth({ method: "oauth" })).toEqual({
      status: "unknown",
      method: "oauth",
    });
  });

  it("omits non-string optional fields", () => {
    expect(
      normalizePreflightAuth({
        status: "authenticated",
        method: ["oauth"],
        detail: 123,
        loginHint: null,
      }),
    ).toEqual({
      status: "authenticated",
    });
  });

  it("returns undefined for absent or malformed auth rows", () => {
    expect(normalizePreflightAuth(null)).toBeUndefined();
    expect(normalizePreflightAuth("authenticated")).toBeUndefined();
  });
});

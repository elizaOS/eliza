/**
 * Browser-stub contract tests exercise the real Vercel OIDC shim and preserve
 * its deliberately empty token/context behavior plus exported error classes.
 */
import { describe, expect, it } from "vitest";
import {
  AccessTokenMissingError,
  getContext,
  getVercelOidcToken,
  getVercelOidcTokenSync,
  getVercelToken,
  RefreshAccessTokenFailedError,
} from "../vercel-oidc.ts";

describe("vercel-oidc browser stub", () => {
  it("returns an empty context", () => {
    expect(getContext()).toEqual({});
  });

  it("returns empty tokens from every getter", async () => {
    expect(await getVercelOidcToken()).toBe("");
    expect(getVercelOidcTokenSync()).toBe("");
    expect(await getVercelToken()).toBe("");
  });

  it("exposes error classes", () => {
    expect(new AccessTokenMissingError()).toBeInstanceOf(Error);
    expect(new RefreshAccessTokenFailedError()).toBeInstanceOf(Error);
  });

  it("keeps the two error classes distinct so callers classify failures", () => {
    const access = new AccessTokenMissingError();
    const refresh = new RefreshAccessTokenFailedError();
    expect(access).toBeInstanceOf(AccessTokenMissingError);
    expect(refresh).toBeInstanceOf(RefreshAccessTokenFailedError);
    expect(access).not.toBeInstanceOf(RefreshAccessTokenFailedError);
    expect(refresh).not.toBeInstanceOf(AccessTokenMissingError);
  });

  it("propagates constructor messages through the Error contract", () => {
    expect(new AccessTokenMissingError("missing token").message).toBe(
      "missing token",
    );
    expect(new RefreshAccessTokenFailedError("refresh failed").message).toBe(
      "refresh failed",
    );
  });

  it("is catchable as a thrown Error", () => {
    try {
      throw new RefreshAccessTokenFailedError("refresh failed");
    } catch (error) {
      expect(error).toBeInstanceOf(RefreshAccessTokenFailedError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("message", "refresh failed");
    }
  });

  it("returns a fresh context object on every call", () => {
    const first = getContext();
    const second = getContext();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.keys(getContext())).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  AccessTokenMissingError,
  RefreshAccessTokenFailedError,
  getContext,
  getVercelOidcToken,
  getVercelOidcTokenSync,
  getVercelToken,
} from "./vercel-oidc.ts";

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
});

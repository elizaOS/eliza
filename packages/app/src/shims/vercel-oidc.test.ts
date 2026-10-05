import { describe, expect, it } from "vitest";
import {
  AccessTokenMissingError,
  getVercelOidcToken,
  getVercelOidcTokenSync,
  getVercelToken,
} from "./vercel-oidc";

describe("browser OIDC boundary", () => {
  it.each([getVercelOidcToken, getVercelToken])(
    "rejects unavailable token requests instead of returning an empty credential",
    async (getToken) => {
      await expect(getToken()).rejects.toBeInstanceOf(AccessTokenMissingError);
    },
  );

  it("throws the same typed failure for synchronous requests", () => {
    expect(getVercelOidcTokenSync).toThrow(AccessTokenMissingError);
  });
});

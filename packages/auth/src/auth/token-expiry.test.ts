/** The auth-shape classifier must treat one expiry phrase the same in every form. */
import { describe, expect, it } from "vitest";
import {
  classifyAuthFailureReason,
  isRefreshTokenExpiryText,
  isTokenExpiryText,
} from "./token-expiry.ts";

describe("isTokenExpiryText", () => {
  it("recognizes an access-token expiry phrased with an infix verb", () => {
    expect(isTokenExpiryText("Your token has expired.")).toBe(true);
    expect(isTokenExpiryText("The access_token is expired.")).toBe(true);
    expect(isTokenExpiryText("session expired")).toBe(true);
  });

  it("recognizes a session expiry phrased with the same infix verb", () => {
    expect(isTokenExpiryText("Guest session has expired")).toBe(true);
    expect(isTokenExpiryText("Interaction session is expired.")).toBe(true);
  });

  it("keeps refresh-token expiry out of the access-token classifier", () => {
    expect(isRefreshTokenExpiryText("refresh token has expired")).toBe(true);
    expect(isTokenExpiryText("refresh token has expired")).toBe(false);
    expect(classifyAuthFailureReason("refresh token has expired")).toBe(
      "needs_reauth",
    );
  });
});

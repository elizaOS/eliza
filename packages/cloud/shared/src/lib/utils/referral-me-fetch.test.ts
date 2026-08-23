/**
 * Coverage for referral-me fetch.
 */
import { describe, expect, it } from "vitest";

import { ApiResponseError, REFERRALS_ME_API_PATH } from "./referral-me-fetch.js";

describe("referral-me-fetch", () => {
  it("exposes path", () => {
    expect(REFERRALS_ME_API_PATH).toBe("/api/v1/referrals");
  });

  it("ApiResponseError has status", () => {
    const err = new ApiResponseError(401, "unauthorized");
    expect(err.status).toBe(401);
    expect(err.message).toContain("unauthorized");
    expect(err.name).toBe("ApiResponseError");
  });

  it("uses default message when no serverMessage", () => {
    const err = new ApiResponseError(500);
    expect(err.message).toContain("500");
  });

  it("ApiResponseError is instance of Error", () => {
    expect(new ApiResponseError(403) instanceof Error).toBe(true);
  });
});

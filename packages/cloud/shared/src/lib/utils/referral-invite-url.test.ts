/**
 * Coverage for referral-invite-url.
 */
import { describe, expect, it } from "vitest";
import { buildReferralInviteLoginUrl } from "./referral-invite-url.js";

describe("referral-invite-url", () => {
  it("builds url", () => {
    expect(buildReferralInviteLoginUrl("https://eliza.app", "abc123")).toBe(
      "https://eliza.app/login?ref=abc123",
    );
  });
  it("trims trailing slash", () => {
    expect(buildReferralInviteLoginUrl("https://eliza.app/", "code")).toBe(
      "https://eliza.app/login?ref=code",
    );
  });
  it("encodes", () => {
    expect(buildReferralInviteLoginUrl("https://eliza.app", "a b")).toContain("a%20b");
  });
});

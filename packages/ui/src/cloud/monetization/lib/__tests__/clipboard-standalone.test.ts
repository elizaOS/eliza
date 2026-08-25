/**
 * Unit tests for monetization clipboard utilities and referral invite url generation.
 */
import { describe, expect, it } from "vitest";
import { buildReferralInviteLoginUrl } from "../clipboard.ts";

describe("monetization clipboard", () => {
  describe("buildReferralInviteLoginUrl", () => {
    it("constructs login URL with referral query parameter", () => {
      const url = buildReferralInviteLoginUrl("https://eliza.app", "INVITE123");
      expect(url).toBe("https://eliza.app/login?ref=INVITE123");
    });

    it("strips trailing slashes from origin", () => {
      const url = buildReferralInviteLoginUrl(
        "https://eliza.app/",
        "INVITE_CODE",
      );
      expect(url).toBe("https://eliza.app/login?ref=INVITE_CODE");
    });

    it("URI-encodes special characters in referral code", () => {
      const url = buildReferralInviteLoginUrl(
        "http://localhost:3000",
        "code with spaces & symbols",
      );
      expect(url).toBe(
        "http://localhost:3000/login?ref=code%20with%20spaces%20%26%20symbols",
      );
    });
  });
});

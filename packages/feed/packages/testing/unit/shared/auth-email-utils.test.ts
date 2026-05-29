/**
 * Auth Email Utilities Unit Tests
 * Tests for email extraction and admin domain checking from auth user objects
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AuthEmailAccount, AuthUserWithEmails } from "@feed/shared";

// Import from absolute source path with cache-busting to avoid mocked @feed/shared.
const { checkForAdminEmail, findEmailByDomain, getAllVerifiedEmails } =
  await import(
    `${import.meta.dir}/../../../shared/src/auth/auth-email-utils?t=${Date.now()}`
  );

describe("Auth Email Utilities", () => {
  describe("getAllVerifiedEmails", () => {
    it("should return empty array for null user", () => {
      expect(getAllVerifiedEmails(null)).toEqual([]);
    });

    it("should return empty array for undefined user", () => {
      expect(getAllVerifiedEmails(undefined)).toEqual([]);
    });

    it("should return empty array for user with no emails", () => {
      const user: AuthUserWithEmails = {};
      expect(getAllVerifiedEmails(user)).toEqual([]);
    });

    it("should return primary email when present and verified", () => {
      const user: AuthUserWithEmails = {
        email: {
          address: "user@example.com",
          verified_at: Date.now(),
        },
      };
      expect(getAllVerifiedEmails(user)).toEqual(["user@example.com"]);
    });

    it("should return primary email when no verification timestamps (auth provider behavior)", () => {
      // auth provider only includes email if verified, so trust it even without timestamps
      const user: AuthUserWithEmails = {
        email: {
          address: "user@example.com",
        },
      };
      expect(getAllVerifiedEmails(user)).toEqual(["user@example.com"]);
    });

    it("should return emails from linkedAccounts when verified", () => {
      const user: AuthUserWithEmails = {
        linkedAccounts: [
          {
            type: "email",
            address: "linked@example.com",
            verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      expect(getAllVerifiedEmails(user)).toEqual(["linked@example.com"]);
    });

    it("should NOT return unverified emails from linkedAccounts", () => {
      const user: AuthUserWithEmails = {
        linkedAccounts: [
          {
            type: "email",
            address: "unverified@example.com",
            // No verification timestamps
          } as AuthEmailAccount,
        ],
      };
      expect(getAllVerifiedEmails(user)).toEqual([]);
    });

    it("should return both primary and linkedAccounts emails", () => {
      const user: AuthUserWithEmails = {
        email: {
          address: "primary@example.com",
          verified_at: Date.now(),
        },
        linkedAccounts: [
          {
            type: "email",
            address: "linked@company.com",
            verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      const emails = getAllVerifiedEmails(user);
      expect(emails).toContain("primary@example.com");
      expect(emails).toContain("linked@company.com");
      expect(emails).toHaveLength(2);
    });

    it("should deduplicate emails when primary appears in linkedAccounts", () => {
      const user: AuthUserWithEmails = {
        email: {
          address: "user@example.com",
          verified_at: Date.now(),
        },
        linkedAccounts: [
          {
            type: "email",
            address: "user@example.com",
            verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      expect(getAllVerifiedEmails(user)).toEqual(["user@example.com"]);
    });

    it("should normalize emails to lowercase", () => {
      const user: AuthUserWithEmails = {
        email: {
          address: "User@Example.COM",
          verified_at: Date.now(),
        },
        linkedAccounts: [
          {
            type: "email",
            address: "LINKED@Company.org",
            verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      const emails = getAllVerifiedEmails(user);
      expect(emails).toContain("user@example.com");
      expect(emails).toContain("linked@company.org");
    });

    it("should handle mixed account types in linkedAccounts", () => {
      const user: AuthUserWithEmails = {
        linkedAccounts: [
          { type: "wallet", address: "0x123" },
          {
            type: "email",
            address: "verified@example.com",
            verified_at: Date.now(),
          } as AuthEmailAccount,
          { type: "farcaster", fid: 12345 },
          {
            type: "email",
            address: "another@example.com",
            verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      const emails = getAllVerifiedEmails(user);
      expect(emails).toContain("verified@example.com");
      expect(emails).toContain("another@example.com");
      expect(emails).toHaveLength(2);
    });

    it("should handle first_verified_at timestamp", () => {
      const user: AuthUserWithEmails = {
        linkedAccounts: [
          {
            type: "email",
            address: "first@example.com",
            first_verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      expect(getAllVerifiedEmails(user)).toEqual(["first@example.com"]);
    });

    it("should handle latest_verified_at timestamp", () => {
      const user: AuthUserWithEmails = {
        linkedAccounts: [
          {
            type: "email",
            address: "latest@example.com",
            latest_verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      expect(getAllVerifiedEmails(user)).toEqual(["latest@example.com"]);
    });
  });

  describe("findEmailByDomain", () => {
    it("should return null for empty emails array", () => {
      expect(findEmailByDomain([], "example.com")).toBeNull();
    });

    it("should return null when adminDomain is null", () => {
      expect(findEmailByDomain(["user@example.com"], null)).toBeNull();
    });

    it("should return null when adminDomain is undefined", () => {
      expect(findEmailByDomain(["user@example.com"], undefined)).toBeNull();
    });

    it("should return null when adminDomain is empty string", () => {
      expect(findEmailByDomain(["user@example.com"], "")).toBeNull();
    });

    it("should return null when no domain matches", () => {
      const emails = ["user@gmail.com", "admin@company.org"];
      expect(findEmailByDomain(emails, "elizalabs.ai")).toBeNull();
    });

    it("should return matching email", () => {
      const emails = ["user@gmail.com", "admin@elizalabs.ai"];
      expect(findEmailByDomain(emails, "elizalabs.ai")).toBe(
        "admin@elizalabs.ai",
      );
    });

    it("should return first matching email when multiple match", () => {
      const emails = [
        "first@elizalabs.ai",
        "second@elizalabs.ai",
        "other@gmail.com",
      ];
      expect(findEmailByDomain(emails, "elizalabs.ai")).toBe(
        "first@elizalabs.ai",
      );
    });

    it("should match domain case-insensitively", () => {
      // Note: findEmailByDomain returns the email as-is from the input array
      // Normalization happens in getAllVerifiedEmails before calling this function
      const emails = ["user@ELIZALABS.AI"];
      expect(findEmailByDomain(emails, "elizalabs.ai")).toBe(
        "user@ELIZALABS.AI",
      );
    });

    it("should match domain case-insensitively (admin domain uppercase)", () => {
      const emails = ["user@elizalabs.ai"];
      expect(findEmailByDomain(emails, "ELIZALABS.AI")).toBe(
        "user@elizalabs.ai",
      );
    });

    it("should trim whitespace from domain", () => {
      const emails = ["user@elizalabs.ai"];
      expect(findEmailByDomain(emails, "  elizalabs.ai  ")).toBe(
        "user@elizalabs.ai",
      );
    });

    it("should not match partial domains", () => {
      const emails = ["user@notelizalabs.ai"];
      expect(findEmailByDomain(emails, "elizalabs.ai")).toBeNull();
    });

    it("should not match subdomains", () => {
      const emails = ["user@sub.elizalabs.ai"];
      expect(findEmailByDomain(emails, "elizalabs.ai")).toBeNull();
    });
  });

  describe("checkForAdminEmail", () => {
    const originalEnv = process.env.ADMIN_EMAIL_DOMAIN;

    beforeAll(() => {
      process.env.ADMIN_EMAIL_DOMAIN = "elizalabs.ai";
    });

    afterAll(() => {
      if (originalEnv) {
        process.env.ADMIN_EMAIL_DOMAIN = originalEnv;
      } else {
        delete process.env.ADMIN_EMAIL_DOMAIN;
      }
    });

    it("should return null adminEmail and empty array for null user", () => {
      const result = checkForAdminEmail(null);
      expect(result.adminEmail).toBeNull();
      expect(result.allVerifiedEmails).toEqual([]);
    });

    it("should return null adminEmail when no emails match admin domain", () => {
      const user: AuthUserWithEmails = {
        email: {
          address: "user@gmail.com",
          verified_at: Date.now(),
        },
      };
      const result = checkForAdminEmail(user);
      expect(result.adminEmail).toBeNull();
      expect(result.allVerifiedEmails).toEqual(["user@gmail.com"]);
    });

    it("should return admin email from primary email", () => {
      const user: AuthUserWithEmails = {
        email: {
          address: "admin@elizalabs.ai",
          verified_at: Date.now(),
        },
      };
      const result = checkForAdminEmail(user);
      expect(result.adminEmail).toBe("admin@elizalabs.ai");
      expect(result.allVerifiedEmails).toEqual(["admin@elizalabs.ai"]);
    });

    it("should return admin email from linkedAccounts", () => {
      const user: AuthUserWithEmails = {
        email: {
          address: "personal@gmail.com",
          verified_at: Date.now(),
        },
        linkedAccounts: [
          {
            type: "email",
            address: "work@elizalabs.ai",
            verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      const result = checkForAdminEmail(user);
      expect(result.adminEmail).toBe("work@elizalabs.ai");
      expect(result.allVerifiedEmails).toContain("personal@gmail.com");
      expect(result.allVerifiedEmails).toContain("work@elizalabs.ai");
    });

    it("should find admin email even when primary is not admin domain", () => {
      const user: AuthUserWithEmails = {
        linkedAccounts: [
          { type: "wallet", address: "0x123" },
          { type: "farcaster", fid: 12345 },
          {
            type: "email",
            address: "hidden@elizalabs.ai",
            verified_at: Date.now(),
          } as AuthEmailAccount,
        ],
      };
      const result = checkForAdminEmail(user);
      expect(result.adminEmail).toBe("hidden@elizalabs.ai");
    });
  });
});

/**
 * Verifies that saved-login listings decode canonical account keys and expose
 * persisted encoding corruption as a typed, secret-safe vault failure.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSavedLogins,
  SavedLoginKeyFormatError,
  setSavedLogin,
} from "../src/credentials.js";
import { createTestVault, type TestVault } from "../src/testing.js";

describe("credentials — listing account encoding", () => {
  let test: TestVault;

  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

  it("lists a canonical percent-encoded username", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "user.name+tag@site.co.uk",
      password: "canonical-password",
    });

    await expect(listSavedLogins(test.vault, "github.com")).resolves.toEqual([
      expect.objectContaining({
        domain: "github.com",
        username: "user.name+tag@site.co.uk",
      }),
    ]);
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed account encoding %s with a typed failure",
    async (malformedAccount) => {
      await test.vault.set(
        `creds.github.com.private-account-${malformedAccount}`,
        "stored-password-must-not-leak",
        { sensitive: true },
      );

      const rejection = await listSavedLogins(test.vault, "github.com").catch(
        (error: unknown) => error,
      );

      expect(rejection).toBeInstanceOf(SavedLoginKeyFormatError);
      expect(rejection).toMatchObject({
        code: "VAULT_SAVED_LOGIN_KEY_FORMAT_INVALID",
        context: {
          operation: "listSavedLogins",
          domain: "github.com",
        },
      });

      const diagnostic = [
        String(rejection),
        JSON.stringify(rejection),
        String((rejection as Error & { cause?: unknown }).cause),
      ].join("\n");
      expect(diagnostic).not.toContain("private-account");
      expect(diagnostic).not.toContain(malformedAccount);
      expect(diagnostic).not.toContain("stored-password-must-not-leak");
    },
  );
});

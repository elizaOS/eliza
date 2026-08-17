/**
 * Saved-login listing account-segment encoding is leftover tax after
 * other path-decode work. Stock develop called decodeURIComponent on
 * every listed account segment, so a vault key with `%` / `%2` / `%ZZ`
 * threw URIError and aborted the whole listing. Canonical encodeAccount
 * usernames still decode. Malformed segments are skipped, not invented.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSavedLogins, setSavedLogin } from "../src/credentials.js";
import { createTestVault, type TestVault } from "../src/testing.js";

describe("credentials — listing account encoding", () => {
  let test: TestVault;

  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

  it("canonical percent-encoded usernames still list", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "user.name+tag@site.co.uk",
      password: "p",
    });
    await expect(listSavedLogins(test.vault, "github.com")).resolves.toEqual([
      expect.objectContaining({
        domain: "github.com",
        username: "user.name+tag@site.co.uk",
      }),
    ]);
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "skips malformed account segment %s without aborting the listing",
    async (token) => {
      await setSavedLogin(test.vault, {
        domain: "github.com",
        username: "alice",
        password: "p1",
      });
      await test.vault.set(`creds.github.com.${token}`, "{}", {
        sensitive: true,
      });

      const list = await listSavedLogins(test.vault, "github.com");
      expect(list.map((entry) => entry.username)).toEqual(["alice"]);
      expect(JSON.stringify(list)).not.toContain(token);
    },
  );
});

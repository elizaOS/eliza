/**
 * Tests saved-login helpers against a real encrypted test vault.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestVault, type TestVault } from "../src/testing/index.js";
import {
  deleteSavedLogin,
  getAutofillAllowed,
  getSavedLogin,
  listSavedLogins,
  SavedLoginKeyFormatError,
  setAutofillAllowed,
  setSavedLogin,
} from "../src/vault/credentials.js";
import { createManager } from "../src/vault/manager.js";

let test: TestVault;

beforeEach(async () => {
  test = await createTestVault();
});
afterEach(async () => {
  await test.dispose();
});

describe("credentials — round-trip", () => {
  it("set + get round-trips a login", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "alice@example.com",
      password: "hunter2",
    });
    const got = await getSavedLogin(
      test.vault,
      "github.com",
      "alice@example.com",
    );
    expect(got).not.toBeNull();
    expect(got?.username).toBe("alice@example.com");
    expect(got?.password).toBe("hunter2");
    expect(got?.domain).toBe("github.com");
    expect(typeof got?.lastModified).toBe("number");
  });

  it("encrypts the password at rest (sensitive flag set)", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "alice",
      password: "supersecret-XYZ",
    });
    const got = await getSavedLogin(test.vault, "github.com", "alice");
    // Password is readable via the vault API (in-memory master key in tests),
    // but it is stored as a sensitive entry (encrypted at rest).
    expect(got?.password).toBe("supersecret-XYZ");
    // The describe() result confirms it is stored as sensitive.
    const keys = await test.vault.list();
    const passwordKey = keys.find((k) => k.includes("github.com"));
    expect(passwordKey).toBeDefined();
    if (!passwordKey) throw new Error("Saved password entry missing");
    const desc = await test.vault.describe(passwordKey);
    expect(desc?.sensitive).toBe(true);
  });

  it("normalises domain casing", async () => {
    await setSavedLogin(test.vault, {
      domain: "GitHub.com",
      username: "alice",
      password: "p1",
    });
    expect(
      await getSavedLogin(test.vault, "github.com", "alice"),
    ).not.toBeNull();
    expect(
      await getSavedLogin(test.vault, "GITHUB.com", "alice"),
    ).not.toBeNull();
  });

  it("returns null for a missing login", async () => {
    expect(await getSavedLogin(test.vault, "missing.com", "noone")).toBeNull();
  });

  it("preserves optional otpSeed and notes", async () => {
    await setSavedLogin(test.vault, {
      domain: "x.com",
      username: "u",
      password: "p",
      otpSeed: "JBSWY3DPEHPK3PXP",
      notes: "work account",
    });
    const got = await getSavedLogin(test.vault, "x.com", "u");
    expect(got?.otpSeed).toBe("JBSWY3DPEHPK3PXP");
    expect(got?.notes).toBe("work account");
  });

  it("allows usernames with special chars (@ / .)", async () => {
    await setSavedLogin(test.vault, {
      domain: "x.com",
      username: "user.name+tag@site.co.uk",
      password: "p",
    });
    const got = await getSavedLogin(
      test.vault,
      "x.com",
      "user.name+tag@site.co.uk",
    );
    expect(got?.username).toBe("user.name+tag@site.co.uk");
  });

  it("lists usernames containing dots without confusing them for domain segments", async () => {
    await setSavedLogin(test.vault, {
      domain: "x.com",
      username: "user.name+tag@site.co.uk",
      password: "p",
    });

    await expect(listSavedLogins(test.vault, "x.com")).resolves.toEqual([
      expect.objectContaining({
        domain: "x.com",
        username: "user.name+tag@site.co.uk",
      }),
    ]);
  });

  it("rejects empty fields", async () => {
    await expect(
      setSavedLogin(test.vault, { domain: "", username: "u", password: "p" }),
    ).rejects.toThrow();
    await expect(
      setSavedLogin(test.vault, {
        domain: "x.com",
        username: "",
        password: "p",
      }),
    ).rejects.toThrow();
    await expect(
      setSavedLogin(test.vault, {
        domain: "x.com",
        username: "u",
        password: "",
      }),
    ).rejects.toThrow();
  });
});

describe("credentials — listSavedLogins", () => {
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

  it("lists multiple users per domain", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "alice",
      password: "p1",
    });
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "bob",
      password: "p2",
    });
    const list = await listSavedLogins(test.vault, "github.com");
    const usernames = list.map((l) => l.username).sort();
    expect(usernames).toEqual(["alice", "bob"]);
    for (const entry of list) {
      expect(entry.domain).toBe("github.com");
      expect(typeof entry.lastModified).toBe("number");
    }
  });

  it("filters by domain", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "alice",
      password: "p1",
    });
    await setSavedLogin(test.vault, {
      domain: "gitlab.com",
      username: "alice",
      password: "p2",
    });
    expect((await listSavedLogins(test.vault, "github.com")).length).toBe(1);
    expect((await listSavedLogins(test.vault, "gitlab.com")).length).toBe(1);
    expect((await listSavedLogins(test.vault)).length).toBe(2);
  });

  it("never reveals password values in summaries", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "alice",
      password: "very-secret-pw",
    });
    const list = await listSavedLogins(test.vault, "github.com");
    expect(JSON.stringify(list)).not.toContain("very-secret-pw");
  });

  it("excludes the autoallow flag from listings", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "alice",
      password: "p1",
    });
    await setAutofillAllowed(test.vault, "github.com", true);
    const list = await listSavedLogins(test.vault, "github.com");
    expect(list.length).toBe(1);
    expect(list[0]?.username).toBe("alice");
  });

  it("returns empty array for unknown domain", async () => {
    expect((await listSavedLogins(test.vault, "no-such.test")).length).toBe(0);
  });
});

describe("credentials — delete", () => {
  it("deletes one login without affecting siblings", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "alice",
      password: "p1",
    });
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "bob",
      password: "p2",
    });
    await deleteSavedLogin(test.vault, "github.com", "alice");
    expect(await getSavedLogin(test.vault, "github.com", "alice")).toBeNull();
    expect(await getSavedLogin(test.vault, "github.com", "bob")).not.toBeNull();
  });

  it("is idempotent", async () => {
    await expect(
      deleteSavedLogin(test.vault, "nope.com", "ghost"),
    ).resolves.toBeUndefined();
  });
});

describe("credentials — autoallow", () => {
  it("defaults to false", async () => {
    expect(await getAutofillAllowed(test.vault, "github.com")).toBe(false);
  });

  it("round-trips true/false", async () => {
    await setAutofillAllowed(test.vault, "github.com", true);
    expect(await getAutofillAllowed(test.vault, "github.com")).toBe(true);
    await setAutofillAllowed(test.vault, "github.com", false);
    expect(await getAutofillAllowed(test.vault, "github.com")).toBe(false);
  });

  it("scopes per domain", async () => {
    await setAutofillAllowed(test.vault, "github.com", true);
    expect(await getAutofillAllowed(test.vault, "gitlab.com")).toBe(false);
  });
});

describe("credentials — domain scoping", () => {
  it("lists only the requested domain when another domain extends it", async () => {
    await setSavedLogin(test.vault, {
      domain: "amazon.com",
      username: "alice@example.com",
      password: "us-password",
    });
    await setSavedLogin(test.vault, {
      domain: "amazon.com.au",
      username: "alice@example.com",
      password: "au-password",
    });
    await setAutofillAllowed(test.vault, "amazon.com.au", true);

    const scoped = await listSavedLogins(test.vault, "amazon.com");
    expect(
      scoped.map(({ domain, username }) => ({ domain, username })),
    ).toEqual([{ domain: "amazon.com", username: "alice@example.com" }]);
    for (const summary of scoped) {
      const login = await getSavedLogin(
        test.vault,
        summary.domain,
        summary.username,
      );
      expect(login?.password).toBe("us-password");
    }

    const all = await listSavedLogins(test.vault);
    expect(
      all.map(({ domain, username }) => `${domain}/${username}`).sort(),
    ).toEqual([
      "amazon.com.au/alice@example.com",
      "amazon.com/alice@example.com",
    ]);
  });
});

describe("credentials — domain entered as a URL or host:port", () => {
  // The in-house identifier is `<domain>:<username>` and autofill looks a
  // login up by `location.hostname`, so the saved domain must be a hostname.
  it.each([
    ["https://GitHub.com/login", "github.com"],
    ["localhost:3000", "localhost"],
    ["http://user@intranet.example:8080/sso?next=/", "intranet.example"],
    ["example.com.", "example.com"],
  ])(
    "saves %s as %s so it can be revealed, autofilled and deleted",
    async (entered, hostname) => {
      await setSavedLogin(test.vault, {
        domain: entered,
        username: "alice",
        password: "pw-1",
      });
      const manager = createManager({
        vault: test.vault,
        exec: async () => {
          throw new Error("external password managers are not used here");
        },
      });
      const { logins } = await manager.listAllSavedLogins();
      const entry = logins.find((login) => login.source === "in-house");
      expect(entry).toMatchObject({
        identifier: `${hostname}:alice`,
        domain: hostname,
      });
      if (!entry) throw new Error("Saved login missing from the list");

      const reveal = await manager.revealSavedLogin(
        "in-house",
        entry.identifier,
      );
      expect(reveal).toMatchObject({ username: "alice", password: "pw-1" });

      // The browser autofill request carries `location.hostname`.
      const candidates = await listSavedLogins(test.vault, hostname);
      expect(candidates.map((login) => login.username)).toEqual(["alice"]);

      // The Logins tab deletes by splitting the identifier at its first colon.
      const colon = entry.identifier.indexOf(":");
      await deleteSavedLogin(
        test.vault,
        entry.identifier.slice(0, colon),
        entry.identifier.slice(colon + 1),
      );
      expect(await getSavedLogin(test.vault, hostname, "alice")).toBeNull();
    },
  );

  it("still rejects a domain with no hostname", async () => {
    await expect(
      setSavedLogin(test.vault, {
        domain: "https:///login",
        username: "alice",
        password: "pw-1",
      }),
    ).rejects.toThrow("setSavedLogin: domain required");
  });

  // A domain that keeps a colon would save `<domain>:<username>` under an
  // identifier the Logins tab splits at the wrong colon, so nothing could
  // reveal or delete it. Refuse it and store nothing.
  it.each([
    "::1",
    "[::1]:3000",
    "http://[::1]/admin",
    "github.com:abc",
    "[127.0.0.1]:3000",
    "[github.com]:443",
  ])("rejects %s instead of saving an undeletable login", async (entered) => {
    await expect(
      setSavedLogin(test.vault, {
        domain: entered,
        username: "alice",
        password: "pw-1",
      }),
    ).rejects.toThrow("setSavedLogin: domain must be a hostname");
    const manager = createManager({
      vault: test.vault,
      exec: async () => {
        throw new Error("external password managers are not used here");
      },
    });
    const { logins } = await manager.listAllSavedLogins();
    expect(logins.filter((login) => login.source === "in-house")).toEqual([]);
  });
});

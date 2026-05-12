import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteSavedLogin,
  getAutofillAllowed,
  getSavedLogin,
  listSavedLogins,
  setAutofillAllowed,
  setSavedLogin,
} from "../src/credentials.js";
import { createTestVault, type TestVault } from "../src/testing.js";

describe("credentials — round-trip", () => {
  let test: TestVault;

  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

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

  it("encrypts the password at rest", async () => {
    await setSavedLogin(test.vault, {
      domain: "github.com",
      username: "alice",
      password: "supersecret-XYZ",
    });
    const raw = await fs.readFile(test.storePath, "utf8");
    expect(raw).not.toContain("supersecret-XYZ");
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
  let test: TestVault;

  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

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
  let test: TestVault;

  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

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
  let test: TestVault;

  beforeEach(async () => {
    test = await createTestVault();
  });
  afterEach(async () => {
    await test.dispose();
  });

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

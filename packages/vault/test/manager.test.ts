import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto.js";
import type { ExecFn } from "../src/external-credentials.js";
import { inMemoryMasterKey } from "../src/master-key.js";
import { createManager, DEFAULT_PREFERENCES } from "../src/manager.js";
import { setSavedLogin } from "../src/credentials.js";
import { createVault } from "../src/vault.js";

describe("manager — preferences", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-mgr-"));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function newManager() {
    return createManager({
      vault: createVault({
        workDir,
        masterKey: inMemoryMasterKey(generateMasterKey()),
      }),
    });
  }

  it("returns DEFAULT_PREFERENCES when nothing is saved", async () => {
    const m = newManager();
    expect(await m.getPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("persists preferences and reads them back", async () => {
    const m = newManager();
    await m.setPreferences({
      enabled: ["1password", "in-house"],
      routing: { "openrouter.apiKey": "1password" },
    });
    const got = await m.getPreferences();
    expect(got.enabled).toEqual(["1password", "in-house"]);
    expect(got.routing?.["openrouter.apiKey"]).toBe("1password");
  });

  it("normalizes empty enabled list to in-house", async () => {
    const m = newManager();
    await m.setPreferences({ enabled: [] as never[] });
    expect((await m.getPreferences()).enabled).toEqual(["in-house"]);
  });

  it("filters unknown backend ids on save", async () => {
    const m = newManager();
    await m.setPreferences({
      enabled: ["1password", "lastpass" as "1password", "in-house"],
    });
    expect((await m.getPreferences()).enabled).toEqual([
      "1password",
      "in-house",
    ]);
  });
});

describe("manager — routing", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-mgr-"));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function newManager() {
    return createManager({
      vault: createVault({
        workDir,
        masterKey: inMemoryMasterKey(generateMasterKey()),
      }),
    });
  }

  it("non-sensitive values always go to in-house regardless of preferences", async () => {
    const m = newManager();
    await m.setPreferences({ enabled: ["1password", "in-house"] });
    await m.set("ui.theme", "dark");
    expect(await m.get("ui.theme")).toBe("dark");
    const desc = await m.vault.describe("ui.theme");
    expect(desc?.source).toBe("file");
  });

  it("sensitive values default to in-house when only in-house is enabled", async () => {
    const m = newManager();
    await m.set("openrouter.apiKey", "sk-or-v1", { sensitive: true });
    expect(await m.get("openrouter.apiKey")).toBe("sk-or-v1");
    const desc = await m.vault.describe("openrouter.apiKey");
    expect(desc?.source).toBe("keychain-encrypted");
  });

  it("external backend preference fails loudly for direct writes", async () => {
    const m = newManager();
    await m.setPreferences({ enabled: ["1password", "in-house"] });
    await expect(
      m.set("openrouter.apiKey", "sk-or-v1", { sensitive: true }),
    ).rejects.toThrow(/cannot accept direct writes/);
    expect(await m.vault.describe("openrouter.apiKey")).toBeNull();
  });

  it("explicit `store` overrides preferences", async () => {
    const m = newManager();
    await m.setPreferences({ enabled: ["1password", "in-house"] });
    await m.set("anthropic.apiKey", "sk-ant", {
      sensitive: true,
      store: "in-house",
    });
    const desc = await m.vault.describe("anthropic.apiKey");
    expect(desc?.source).toBe("keychain-encrypted");
  });

  it("non-sensitive routing override is IGNORED — values stay in-house", async () => {
    // Regression: the routing map could push non-sensitive values
    // (e.g. UI theme) through an external password manager. The
    // documented invariant is that non-sensitive values always go
    // in-house regardless of routing entries.
    const m = newManager();
    await m.setPreferences({
      enabled: ["1password", "in-house"],
      routing: { "ui.theme": "1password" },
    });
    await m.set("ui.theme", "dark"); // non-sensitive
    const desc = await m.vault.describe("ui.theme");
    expect(desc?.source).toBe("file");
  });

  it("per-key routing override wins over enabled[0]", async () => {
    const m = newManager();
    await m.setPreferences({
      enabled: ["1password", "in-house"],
      routing: { "anthropic.apiKey": "in-house" },
    });
    await expect(
      m.set("openrouter.apiKey", "sk-or", { sensitive: true }),
    ).rejects.toThrow(/cannot accept direct writes/);
    await m.set("anthropic.apiKey", "sk-ant", { sensitive: true });
    expect(await m.vault.describe("openrouter.apiKey")).toBeNull();
    expect((await m.vault.describe("anthropic.apiKey"))?.source).toBe(
      "keychain-encrypted",
    );
  });

  it("rejects external direct writes", async () => {
    const m = newManager();
    await expect(
      m.set("k", "v", { sensitive: true, store: "1password" }),
    ).rejects.toThrow(/cannot accept direct writes/);
  });

  it("bitwarden routing throws (not yet first-class)", async () => {
    const m = newManager();
    await expect(
      m.set("k", "v", {
        sensitive: true,
        store: "bitwarden",
      }),
    ).rejects.toThrow(/bitwarden/);
  });
});

describe("manager — list filters internal keys", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-mgr-"));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("does not surface _manager.* keys in list()", async () => {
    const m = createManager({
      vault: createVault({
        workDir,
        masterKey: inMemoryMasterKey(generateMasterKey()),
      }),
    });
    await m.setPreferences({ enabled: ["1password", "in-house"] });
    await m.set("ui.theme", "dark");
    const keys = await m.list();
    expect(keys).toContain("ui.theme");
    expect(keys.find((k) => k.startsWith("_manager."))).toBeUndefined();
  });
});

describe("manager — backend detection", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-mgr-"));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function newManager() {
    return createManager({
      vault: createVault({
        workDir,
        masterKey: inMemoryMasterKey(generateMasterKey()),
      }),
    });
  }

  it("returns a status entry for each known backend", async () => {
    const m = newManager();
    const statuses = await m.detectBackends();
    const ids = statuses.map((s) => s.id).sort();
    expect(ids).toEqual(["1password", "bitwarden", "in-house", "protonpass"]);
  });

  it("in-house is always available and signed-in", async () => {
    const m = newManager();
    const statuses = await m.detectBackends();
    const inHouse = statuses.find((s) => s.id === "in-house");
    expect(inHouse).toMatchObject({
      available: true,
      signedIn: true,
    });
  });

  it("each external backend reports either available or detail", async () => {
    const m = newManager();
    const statuses = await m.detectBackends();
    for (const s of statuses) {
      if (s.id === "in-house") continue;
      // Either it's available with a sign-in flag, or it's not
      // available and there's a detail explaining why.
      if (!s.available) {
        expect(s.detail).toBeDefined();
      }
    }
  });

  it("authMode is null for every backend when CLI is unavailable", async () => {
    // CI machines usually don't have `op` or `bw` installed. Whatever
    // the host detection returns, an unavailable backend must not claim
    // a desktop-app authMode (which would lie about working secrets
    // routing).
    const m = newManager();
    const statuses = await m.detectBackends();
    for (const s of statuses) {
      if (s.id === "in-house") continue;
      if (!s.available) {
        expect(s.authMode).toBe(null);
      } else if (s.signedIn === false) {
        expect(s.authMode).toBe(null);
      } else if (s.id === "1password") {
        // 1Password has two auth modes; either is acceptable when signed in.
        expect(["desktop-app", "session-token"]).toContain(s.authMode);
      }
    }
  });
});

describe("manager — listAllSavedLogins", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-mgr-list-"));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function execStub(
    handler: (cmd: string, args: readonly string[]) => string,
  ): ExecFn {
    return async (cmd, args) => ({ stdout: handler(cmd, args), stderr: "" });
  }

  it("returns in-house entries when no external backend is signed in", async () => {
    const v = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
    const m = createManager({
      vault: v,
      // The 1Password and Bitwarden CLIs may exist on the dev machine
      // (passing isCommandAvailable inside detectBackends), so detection
      // can land on signedIn=true via desktop integration. The STUB
      // drives the actual list call. To assert "in-house only, no
      // failures," seed empty sessions so the list adapters succeed
      // with [] rather than throw BackendNotSignedInError.
      exec: execStub(() => "[]"),
    });
    await v.set("pm.1password.session", "stub-token", { sensitive: true });
    await v.set("pm.bitwarden.session", "stub-token", { sensitive: true });
    // NB: usernames containing `.` (e.g. "alice@example.com" → URL-encoded
    // "alice%40example.com" — still has dots) hit a pre-existing bug in
    // `parseLoginKey` that splits on the last dot. We use a dot-free
    // username here so the assertion isn't tangled with that orthogonal
    // issue; the unified shape is what's under test.
    await setSavedLogin(m.vault, {
      domain: "github.com",
      username: "alice",
      password: "p1",
    });

    const out = await m.listAllSavedLogins();
    expect(out.failures).toEqual([]);
    expect(out.logins).toHaveLength(1);
    expect(out.logins[0]).toMatchObject({
      source: "in-house",
      identifier: "github.com:alice",
      username: "alice",
      domain: "github.com",
      title: "alice",
    });
  });

  it("revealSavedLogin in-house round-trips username + password", async () => {
    const m = createManager({
      vault: createVault({
        workDir,
        masterKey: inMemoryMasterKey(generateMasterKey()),
      }),
      exec: execStub(() => "[]"),
    });
    await setSavedLogin(m.vault, {
      domain: "github.com",
      username: "alice",
      password: "hunter2",
    });
    const out = await m.revealSavedLogin("in-house", "github.com:alice");
    expect(out.password).toBe("hunter2");
    expect(out.username).toBe("alice");
    expect(out.domain).toBe("github.com");
  });

  it("revealSavedLogin throws on malformed in-house identifier", async () => {
    const m = createManager({
      vault: createVault({
        workDir,
        masterKey: inMemoryMasterKey(generateMasterKey()),
      }),
      exec: execStub(() => "[]"),
    });
    await expect(
      m.revealSavedLogin("in-house", "no-colon"),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("filters by domain across in-house entries (case-insensitive)", async () => {
    const m = createManager({
      vault: createVault({
        workDir,
        masterKey: inMemoryMasterKey(generateMasterKey()),
      }),
      exec: execStub(() => "[]"),
    });
    await setSavedLogin(m.vault, {
      domain: "github.com",
      username: "u1",
      password: "p1",
    });
    await setSavedLogin(m.vault, {
      domain: "gitlab.com",
      username: "u2",
      password: "p2",
    });
    const out = await m.listAllSavedLogins({ domain: "GitHub.com" });
    expect(out.logins).toHaveLength(1);
    expect(out.logins[0]?.domain).toBe("github.com");
  });
});

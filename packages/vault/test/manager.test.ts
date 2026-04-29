import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto.js";
import { inMemoryMasterKey } from "../src/master-key.js";
import { createManager, DEFAULT_PREFERENCES } from "../src/manager.js";
import { createVault } from "../src/vault.js";

describe("manager — preferences", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-mgr-"));
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
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-mgr-"));
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

  it("sensitive values route to 1password when first-priority + externalPath given", async () => {
    const m = newManager();
    await m.setPreferences({ enabled: ["1password", "in-house"] });
    await m.set("openrouter.apiKey", "sk-or-v1", {
      sensitive: true,
      externalPath: "Personal/OpenRouter/api-key",
    });
    const desc = await m.vault.describe("openrouter.apiKey");
    expect(desc?.source).toBe("1password");
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

  it("per-key routing override wins over enabled[0]", async () => {
    const m = newManager();
    await m.setPreferences({
      enabled: ["1password", "in-house"],
      routing: { "anthropic.apiKey": "in-house" },
    });
    await m.set("openrouter.apiKey", "sk-or", {
      sensitive: true,
      externalPath: "Personal/OR/key",
    });
    await m.set("anthropic.apiKey", "sk-ant", { sensitive: true });
    expect(
      (await m.vault.describe("openrouter.apiKey"))?.source,
    ).toBe("1password");
    expect(
      (await m.vault.describe("anthropic.apiKey"))?.source,
    ).toBe("keychain-encrypted");
  });

  it("rejects external routing without externalPath", async () => {
    const m = newManager();
    await expect(
      m.set("k", "v", { sensitive: true, store: "1password" }),
    ).rejects.toThrow(/externalPath/);
  });

  it("bitwarden routing throws (not yet first-class)", async () => {
    const m = newManager();
    await expect(
      m.set("k", "v", {
        sensitive: true,
        store: "bitwarden",
        externalPath: "Personal/k",
      }),
    ).rejects.toThrow(/bitwarden/);
  });
});

describe("manager — list filters internal keys", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-mgr-"));
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
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-mgr-"));
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
});

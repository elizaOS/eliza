import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Vault } from "@elizaos/vault";
import { createTestVault, type TestVault } from "@elizaos/vault/testing";
import {
  _resetSharedVaultForTesting,
  mirrorPluginSensitiveToVault,
} from "./vault-mirror";

/**
 * Build a plugin record fragment with the shape `mirrorPluginSensitiveToVault`
 * inspects. Only `parameters[].key` and `parameters[].sensitive` matter.
 */
function pluginWithParams(
  params: Array<{ key: string; sensitive: boolean }>,
): { parameters: Array<{ key: string; sensitive: boolean }> } {
  return { parameters: params };
}

/**
 * Build a vault that throws on every `set` call. Used to assert that
 * mirror failures are collected per-key without aborting the loop.
 */
function alwaysFailingVault(): Vault {
  const stub: Partial<Vault> = {
    async set() {
      throw new Error("simulated keychain failure");
    },
    async setReference() {
      throw new Error("simulated keychain failure");
    },
    async get() {
      throw new Error("not implemented");
    },
    async reveal() {
      throw new Error("not implemented");
    },
    async has() {
      return false;
    },
    async remove() {},
    async list() {
      return [];
    },
    async describe() {
      return null;
    },
    async stats() {
      return { total: 0, sensitive: 0, nonSensitive: 0, references: 0 };
    },
  };
  return stub as Vault;
}

/**
 * Build a vault where `set` succeeds for some keys and throws for
 * others. Used to assert that one failed key does not abort the rest.
 */
function selectivelyFailingVault(failKeys: ReadonlySet<string>): {
  vault: Vault;
  written: Map<string, string>;
} {
  const written = new Map<string, string>();
  const stub: Partial<Vault> = {
    async set(key, value) {
      if (failKeys.has(key)) throw new Error(`simulated fail: ${key}`);
      written.set(key, value);
    },
    async setReference() {},
    async get(key) {
      const v = written.get(key);
      if (v === undefined) throw new Error(`miss: ${key}`);
      return v;
    },
    async reveal(key) {
      const v = written.get(key);
      if (v === undefined) throw new Error(`miss: ${key}`);
      return v;
    },
    async has(key) {
      return written.has(key);
    },
    async remove() {},
    async list() {
      return [...written.keys()];
    },
    async describe() {
      return null;
    },
    async stats() {
      return {
        total: written.size,
        sensitive: written.size,
        nonSensitive: 0,
        references: 0,
      };
    },
  };
  return { vault: stub as Vault, written };
}

describe("mirrorPluginSensitiveToVault", () => {
  let testVault: TestVault | null;

  beforeEach(() => {
    testVault = null;
    _resetSharedVaultForTesting(null);
  });

  afterEach(async () => {
    _resetSharedVaultForTesting(null);
    if (testVault) await testVault.dispose();
  });

  it("writes each sensitive field to the vault", async () => {
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);

    const result = await mirrorPluginSensitiveToVault(
      pluginWithParams([
        { key: "OPENAI_API_KEY", sensitive: true },
        { key: "OPENAI_BASE_URL", sensitive: false },
        { key: "OPENAI_ORG_ID", sensitive: true },
      ]),
      {
        config: {
          OPENAI_API_KEY: "sk-test-1234567890",
          OPENAI_BASE_URL: "https://api.example.com",
          OPENAI_ORG_ID: "org-abc",
        },
      },
    );

    expect(result.failures).toEqual([]);
    expect(await testVault.vault.get("OPENAI_API_KEY")).toBe(
      "sk-test-1234567890",
    );
    expect(await testVault.vault.get("OPENAI_ORG_ID")).toBe("org-abc");
    // Non-sensitive params are NOT mirrored.
    expect(await testVault.vault.has("OPENAI_BASE_URL")).toBe(false);
  });

  it("skips empty / missing values without throwing", async () => {
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);

    const result = await mirrorPluginSensitiveToVault(
      pluginWithParams([
        { key: "OPENAI_API_KEY", sensitive: true },
        { key: "ANTHROPIC_API_KEY", sensitive: true },
        { key: "GOOGLE_API_KEY", sensitive: true },
      ]),
      {
        config: {
          OPENAI_API_KEY: "",
          ANTHROPIC_API_KEY: "real-value",
          // GOOGLE_API_KEY missing entirely
        },
      },
    );

    expect(result.failures).toEqual([]);
    expect(await testVault.vault.has("OPENAI_API_KEY")).toBe(false);
    expect(await testVault.vault.has("GOOGLE_API_KEY")).toBe(false);
    expect(await testVault.vault.get("ANTHROPIC_API_KEY")).toBe("real-value");
  });

  it("returns no failures and writes nothing when no sensitive params declared", async () => {
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);

    const result = await mirrorPluginSensitiveToVault(
      pluginWithParams([
        { key: "MODEL_NAME", sensitive: false },
        { key: "TIMEOUT_MS", sensitive: false },
      ]),
      { config: { MODEL_NAME: "gpt-5", TIMEOUT_MS: "30000" } },
    );

    expect(result.failures).toEqual([]);
    expect(await testVault.vault.list()).toEqual([]);
  });

  it("returns no failures when the body has no config object at all", async () => {
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);

    const result = await mirrorPluginSensitiveToVault(
      pluginWithParams([{ key: "OPENAI_API_KEY", sensitive: true }]),
      { enabled: true },
    );

    expect(result.failures).toEqual([]);
    expect(await testVault.vault.list()).toEqual([]);
  });

  it("collects every failed key when the vault rejects all writes", async () => {
    _resetSharedVaultForTesting(alwaysFailingVault());

    const result = await mirrorPluginSensitiveToVault(
      pluginWithParams([
        { key: "OPENAI_API_KEY", sensitive: true },
        { key: "ANTHROPIC_API_KEY", sensitive: true },
      ]),
      {
        config: {
          OPENAI_API_KEY: "sk-1",
          ANTHROPIC_API_KEY: "sk-2",
        },
      },
    );

    expect(result.failures).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  });

  it("continues past a failed key and writes the remaining keys", async () => {
    const { vault, written } = selectivelyFailingVault(
      new Set(["OPENAI_API_KEY"]),
    );
    _resetSharedVaultForTesting(vault);

    const result = await mirrorPluginSensitiveToVault(
      pluginWithParams([
        { key: "OPENAI_API_KEY", sensitive: true },
        { key: "ANTHROPIC_API_KEY", sensitive: true },
        { key: "GOOGLE_API_KEY", sensitive: true },
      ]),
      {
        config: {
          OPENAI_API_KEY: "sk-fail",
          ANTHROPIC_API_KEY: "sk-good-1",
          GOOGLE_API_KEY: "sk-good-2",
        },
      },
    );

    expect(result.failures).toEqual(["OPENAI_API_KEY"]);
    expect(written.get("ANTHROPIC_API_KEY")).toBe("sk-good-1");
    expect(written.get("GOOGLE_API_KEY")).toBe("sk-good-2");
    expect(written.has("OPENAI_API_KEY")).toBe(false);
  });
});

/**
 * Source-text guard for the reveal-route vault-first lookup. Mirrors
 * the pattern used in `server.cloud-disconnect.test.ts`: the route
 * lives inside `plugins-compat-routes.ts` which transitively imports
 * the entire @elizaos/agent runtime, so we cannot stand it up under
 * vitest without building every plugin. Instead we read the source
 * file and assert the lookup order.
 *
 * Failure mode this guards: someone re-orders the reveal route so
 * env is consulted before the vault, regressing to "fresh installs
 * see stale env values even though the user just saved into the vault."
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_COMPAT = path.resolve(
  HERE,
  "..",
  "api",
  "plugins-compat-routes.ts",
);

describe("plugins-compat reveal route — vault-first source guard", () => {
  function readSource(): string {
    return readFileSync(PLUGINS_COMPAT, "utf8");
  }

  it("calls sharedVault().get(key) inside the reveal route", () => {
    const src = readSource();
    expect(src).toMatch(/\/api\/plugins\/[^/]+\/reveal/);
    expect(src).toMatch(/sharedVault\(\)\s*\.\s*get\s*\(/);
  });

  it("falls back to process.env after the vault attempt", () => {
    const src = readSource();
    // Vault lookup must appear before the legacy `process.env[key]` read
    // inside the reveal handler. We anchor on a unique-ish substring
    // ("/reveal") and assert ordering after that anchor.
    const revealIdx = src.indexOf("/reveal");
    expect(revealIdx).toBeGreaterThanOrEqual(0);
    const after = src.slice(revealIdx);
    const vaultIdx = after.indexOf("sharedVault().get(");
    const envIdx = after.indexOf("process.env[key]");
    expect(vaultIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(vaultIdx).toBeLessThan(envIdx);
  });
});

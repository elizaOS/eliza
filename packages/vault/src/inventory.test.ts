/**
 * Unit tests for vault inventory categorization, metadata management, and listing.
 */

import { describe, expect, it } from "vitest";
import {
  categorizeKey,
  inferProviderId,
  listVaultInventory,
  META_PREFIX,
  profileStorageKey,
  readEntryMeta,
  removeEntryMeta,
  setEntryMeta,
} from "./inventory.js";
import type { Vault } from "./vault.js";

function makeMockVault(store: Record<string, string> = {}): Vault {
  const data = new Map<string, string>(Object.entries(store));
  return {
    async get(key: string) {
      const val = data.get(key);
      if (val === undefined) throw new Error(`key not found: ${key}`);
      return val;
    },
    async set(key: string, value: string) {
      data.set(key, value);
    },
    async has(key: string) {
      return data.has(key);
    },
    async remove(key: string) {
      data.delete(key);
    },
    async list() {
      return Array.from(data.keys());
    },
    async describe(key: string) {
      if (!data.has(key)) return null;
      return { source: "keychain-encrypted", lastModified: 1700000000000 };
    },
  } as unknown as Vault;
}

describe("vault inventory", () => {
  describe("categorizeKey and inferProviderId", () => {
    it("categorizes keys based on prefixes and patterns", () => {
      expect(categorizeKey("creds.github.com.user")).toBe("credential");
      expect(categorizeKey("pm.1password.session")).toBe("session");
      expect(categorizeKey("connector.agent1.discord.acc.token")).toBe(
        "connector",
      );
      expect(categorizeKey("EVM_PRIVATE_KEY")).toBe("wallet");
      expect(categorizeKey("wallet.solana.key")).toBe("wallet");
      expect(categorizeKey("OPENAI_API_KEY")).toBe("provider");
      expect(categorizeKey("ANTHROPIC_API_KEY")).toBe("provider");
      expect(categorizeKey("CUSTOM_PLUGIN_SECRET")).toBe("plugin");
    });

    it("infers provider IDs from exact keys and pattern matches", () => {
      expect(inferProviderId("OPENAI_API_KEY")).toBe("openai");
      expect(inferProviderId("ANTHROPIC_API_KEY")).toBe("anthropic");
      expect(inferProviderId("GEMINI_API_KEY")).toBe("gemini");
      expect(inferProviderId("CUSTOM_API_KEY")).toBe("custom");
      expect(inferProviderId("UNRECOGNIZED_VAR")).toBeNull();
    });
  });

  describe("profileStorageKey", () => {
    it("constructs formatted dot-delimited storage key", () => {
      expect(profileStorageKey("OPENROUTER_API_KEY", "work")).toBe(
        "OPENROUTER_API_KEY.profile.work",
      );
      expect(profileStorageKey("ANTHROPIC_API_KEY", "prod-1")).toBe(
        "ANTHROPIC_API_KEY.profile.prod-1",
      );
    });

    it("rejects empty or invalid profile IDs", () => {
      expect(() => profileStorageKey("KEY", "")).toThrowError(TypeError);
      expect(() => profileStorageKey("KEY", "invalid/char")).toThrowError(
        TypeError,
      );
    });
  });

  describe("metadata management and inventory listing", () => {
    it("reads, sets, and removes entry metadata", async () => {
      const vault = makeMockVault();

      await setEntryMeta(vault, "ANTHROPIC_API_KEY", {
        label: "Anthropic Work",
        category: "provider",
        activeProfile: "work",
      });

      const meta = await readEntryMeta(vault, "ANTHROPIC_API_KEY");
      expect(meta?.label).toBe("Anthropic Work");
      expect(meta?.category).toBe("provider");
      expect(meta?.activeProfile).toBe("work");
      expect(meta?.lastModified).toBeDefined();

      await removeEntryMeta(vault, "ANTHROPIC_API_KEY");
      expect(await readEntryMeta(vault, "ANTHROPIC_API_KEY")).toBeNull();
    });

    it("lists vault inventory while filtering internal meta keys and rolling up profile children", async () => {
      const vault = makeMockVault({
        OPENROUTER_API_KEY: "bare-key",
        "OPENROUTER_API_KEY.profile.work": "work-key",
        [`${META_PREFIX}OPENROUTER_API_KEY`]: JSON.stringify({
          profiles: [{ id: "work", label: "Work Account" }],
          activeProfile: "work",
        }),
        EVM_PRIVATE_KEY: "0x12345",
      });

      const inventory = await listVaultInventory(vault);

      // Should surface OPENROUTER_API_KEY and EVM_PRIVATE_KEY, rolling up child profiles
      expect(inventory).toHaveLength(2);

      const openrouter = inventory.find(
        (entry) => entry.key === "OPENROUTER_API_KEY",
      );
      expect(openrouter).toBeDefined();
      expect(openrouter?.hasProfiles).toBe(true);
      expect(openrouter?.activeProfile).toBe("work");
      expect(openrouter?.profiles).toEqual([
        { id: "work", label: "Work Account" },
      ]);

      const evm = inventory.find((entry) => entry.key === "EVM_PRIVATE_KEY");
      expect(evm).toBeDefined();
      expect(evm?.category).toBe("wallet");
    });
  });
});

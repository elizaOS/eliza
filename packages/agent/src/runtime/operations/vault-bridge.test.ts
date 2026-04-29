import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createManager, type SecretsManager } from "@elizaos/vault";
import { createTestVault, type TestVault } from "@elizaos/vault/testing";
import {
  persistProviderApiKey,
  resolveProviderApiKey,
  vaultKeyForProviderApiKey,
} from "./vault-bridge.js";

let testVault: TestVault;
let secrets: SecretsManager;

beforeEach(async () => {
  testVault = await createTestVault();
  secrets = createManager({ vault: testVault.vault });
});

afterEach(async () => {
  await testVault.dispose();
});

describe("vaultKeyForProviderApiKey", () => {
  test("returns the canonical providers.<provider>.api-key key", () => {
    expect(vaultKeyForProviderApiKey("openai")).toBe(
      "providers.openai.api-key",
    );
    expect(vaultKeyForProviderApiKey("anthropic-subscription")).toBe(
      "providers.anthropic-subscription.api-key",
    );
  });

  test("rejects empty provider id", () => {
    expect(() => vaultKeyForProviderApiKey("")).toThrow();
  });

  test("rejects provider id containing the namespace separator", () => {
    expect(() => vaultKeyForProviderApiKey("foo.bar")).toThrow();
  });
});

describe("persistProviderApiKey + resolveProviderApiKey", () => {
  test("writes encrypted at rest under the canonical key and round-trips through reveal", async () => {
    const ref = await persistProviderApiKey({
      secrets,
      normalizedProvider: "openai",
      apiKey: "sk-secret-12345",
      caller: "test:provider-switch-route",
    });
    expect(ref).toBe("providers.openai.api-key");
    const resolved = await resolveProviderApiKey({
      secrets,
      apiKeyRef: ref,
      caller: "test:resolve",
    });
    expect(resolved).toBe("sk-secret-12345");
  });

  test("describe() reports sensitive=true; ciphertext on disk does not contain plaintext", async () => {
    const apiKey = "sk-very-secret-value-do-not-leak";
    await persistProviderApiKey({
      secrets,
      normalizedProvider: "anthropic",
      apiKey,
      caller: "test",
    });
    const desc = await secrets.vault.describe("providers.anthropic.api-key");
    expect(desc?.sensitive).toBe(true);
    expect(desc?.source).toBe("keychain-encrypted");
    const fs = await import("node:fs/promises");
    const onDisk = await fs.readFile(testVault.storePath, "utf8");
    expect(onDisk).not.toContain(apiKey);
  });

  test("audit log records caller for both set and reveal", async () => {
    await persistProviderApiKey({
      secrets,
      normalizedProvider: "openai",
      apiKey: "sk-test",
      caller: "provider-switch-route",
    });
    await resolveProviderApiKey({
      secrets,
      apiKeyRef: "providers.openai.api-key",
      caller: "runtime-ops:reload-hot",
    });
    const audit = await testVault.getAuditRecords();
    const setEntry = audit.find(
      (a) => a.action === "set" && a.key === "providers.openai.api-key",
    );
    const revealEntry = audit.find(
      (a) => a.action === "reveal" && a.key === "providers.openai.api-key",
    );
    expect(setEntry?.caller).toBe("provider-switch-route");
    expect(revealEntry?.caller).toBe("runtime-ops:reload-hot");
    // Sanity: the audit log must NEVER contain the secret value.
    const fs = await import("node:fs/promises");
    const auditRaw = await fs.readFile(testVault.auditLogPath, "utf8");
    expect(auditRaw).not.toContain("sk-test");
  });

  test("resolveProviderApiKey returns undefined for missing ref", async () => {
    const resolved = await resolveProviderApiKey({
      secrets,
      apiKeyRef: "providers.never-set.api-key",
      caller: "test",
    });
    expect(resolved).toBeUndefined();
  });

  test("resolveProviderApiKey returns undefined when apiKeyRef is undefined", async () => {
    const resolved = await resolveProviderApiKey({
      secrets,
      apiKeyRef: undefined,
      caller: "test",
    });
    expect(resolved).toBeUndefined();
  });

  test("overwriting an existing ref replaces the value cleanly", async () => {
    await persistProviderApiKey({
      secrets,
      normalizedProvider: "openai",
      apiKey: "sk-first",
      caller: "test",
    });
    await persistProviderApiKey({
      secrets,
      normalizedProvider: "openai",
      apiKey: "sk-second",
      caller: "test",
    });
    const resolved = await resolveProviderApiKey({
      secrets,
      apiKeyRef: "providers.openai.api-key",
      caller: "test",
    });
    expect(resolved).toBe("sk-second");
  });
});

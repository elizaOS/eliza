import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Vault } from "@elizaos/vault";
import { createTestVault, type TestVault } from "@elizaos/vault/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVaultBootstrap } from "./vault-bootstrap";
import { _resetSharedVaultForTesting } from "./vault-mirror";

interface Sandbox {
  stateDir: string;
  configPath: string;
  configEnvPath: string;
  cleanup: () => void;
  prevEnv: Record<string, string | undefined>;
}

/**
 * Capture every process.env key that looks like a sensitive credential
 * (so the bootstrap's process.env walker doesn't pick up the developer's
 * real shell env mid-test). Restored on cleanup.
 */
function snapshotAndClearSensitiveProcessEnv(): Record<string, string> {
  const sensitivePattern =
    /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_SIGNING_|ENCRYPTION_)/i;
  const cleared: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (!sensitivePattern.test(key)) continue;
    const value = process.env[key];
    if (typeof value === "string") {
      cleared[key] = value;
      delete process.env[key];
    }
  }
  return cleared;
}

function createSandbox(): Sandbox {
  const stateDir = mkdtempSync(path.join(tmpdir(), "eliza-vault-boot-"));
  const configPath = path.join(stateDir, "eliza.json");
  const configEnvPath = path.join(stateDir, "config.env");
  const prevEnv: Record<string, string | undefined> = {
    ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
    ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
    ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
    ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
    ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE,
  };
  const clearedSensitive = snapshotAndClearSensitiveProcessEnv();
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_NAMESPACE = "eliza";
  return {
    stateDir,
    configPath,
    configEnvPath,
    prevEnv,
    cleanup: () => {
      rmSync(stateDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      // Also drop any sensitive keys that got planted by loadElizaConfig
      // during the test — they came from our test's eliza.json.
      for (const key of Object.keys(process.env)) {
        if (
          /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_SIGNING_|ENCRYPTION_)/i.test(
            key,
          ) &&
          !(key in clearedSensitive)
        ) {
          delete process.env[key];
        }
      }
      // Restore the developer's original sensitive env.
      for (const [k, v] of Object.entries(clearedSensitive)) {
        process.env[k] = v;
      }
    },
  };
}

function writeElizaJson(configPath: string, body: unknown): void {
  writeFileSync(configPath, JSON.stringify(body, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function selectivelyFailingVault(
  inner: Vault,
  failKeys: ReadonlySet<string>,
): Vault {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "set") {
        return async (key: string, value: string, opts?: unknown) => {
          if (failKeys.has(key)) throw new Error(`simulated fail: ${key}`);
          return await (target.set as Vault["set"])(
            key,
            value,
            opts as Parameters<Vault["set"]>[2],
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("runVaultBootstrap", () => {
  let testVault: TestVault | null = null;
  let sandbox: Sandbox | null = null;

  beforeEach(() => {
    testVault = null;
    sandbox = null;
    _resetSharedVaultForTesting(null);
  });

  afterEach(async () => {
    _resetSharedVaultForTesting(null);
    if (testVault) await testVault.dispose();
    if (sandbox) sandbox.cleanup();
  });

  it("clean-slate migration: pushes plaintext, rewrites sentinels, marks hydrated", async () => {
    sandbox = createSandbox();
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);

    writeElizaJson(sandbox.configPath, {
      env: { OPENAI_API_KEY: "sk-plain-openai", LOG_LEVEL: "info" },
      plugins: {
        entries: {
          "@elizaos/plugin-anthropic": {
            enabled: true,
            config: { ANTHROPIC_API_KEY: "sk-plain-anthropic" },
          },
        },
      },
    });

    const result = await runVaultBootstrap({
      stateDir: sandbox.stateDir,
      configPath: sandbox.configPath,
    });

    expect(result.failed).toEqual([]);
    expect(result.migrated).toBeGreaterThanOrEqual(2);

    const reread = await readJson<{
      env: Record<string, string>;
      plugins: { entries: Record<string, { config: Record<string, string> }> };
    }>(sandbox.configPath);
    expect(reread.env.OPENAI_API_KEY).toBe("vault://OPENAI_API_KEY");
    expect(reread.env.LOG_LEVEL).toBe("info");
    const anthropicEntry = reread.plugins.entries["@elizaos/plugin-anthropic"];
    if (!anthropicEntry) throw new Error("anthropic entry missing");
    expect(anthropicEntry.config.ANTHROPIC_API_KEY).toBe(
      "vault://ANTHROPIC_API_KEY",
    );

    expect(await testVault.vault.get("OPENAI_API_KEY")).toBe("sk-plain-openai");
    expect(await testVault.vault.get("ANTHROPIC_API_KEY")).toBe(
      "sk-plain-anthropic",
    );

    const marker = await readJson<{
      version: number;
      migratedKeys: string[];
    }>(path.join(sandbox.stateDir, ".vault-hydrated.json"));
    expect(marker.version).toBe(1);
    expect(marker.migratedKeys.sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]);
  });

  it("idempotent re-run: marker exists, no plaintext, near-no-op", async () => {
    sandbox = createSandbox();
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);

    writeElizaJson(sandbox.configPath, {
      env: { OPENAI_API_KEY: "sk-plain" },
    });

    const first = await runVaultBootstrap({ stateDir: sandbox.stateDir });
    expect(first.migrated).toBe(1);

    const second = await runVaultBootstrap({ stateDir: sandbox.stateDir });
    expect(second.migrated).toBe(0);
    expect(second.failed).toEqual([]);
    expect(second.alreadyHydrated).toBeGreaterThan(0);

    const reread = await readJson<{ env: Record<string, string> }>(
      sandbox.configPath,
    );
    expect(reread.env.OPENAI_API_KEY).toBe("vault://OPENAI_API_KEY");
  });

  it("partial vault.set failure: one key fails, others succeed", async () => {
    sandbox = createSandbox();
    testVault = await createTestVault();
    const failing = selectivelyFailingVault(
      testVault.vault,
      new Set(["GROQ_API_KEY"]),
    );
    _resetSharedVaultForTesting(failing);

    writeElizaJson(sandbox.configPath, {
      env: {
        OPENAI_API_KEY: "sk-ok",
        GROQ_API_KEY: "sk-fail",
      },
    });

    const result = await runVaultBootstrap({
      stateDir: sandbox.stateDir,
      vault: failing,
    });
    expect(result.failed).toEqual(["GROQ_API_KEY"]);
    expect(result.migrated).toBe(1);

    const reread = await readJson<{ env: Record<string, string> }>(
      sandbox.configPath,
    );
    expect(reread.env.OPENAI_API_KEY).toBe("vault://OPENAI_API_KEY");
    expect(reread.env.GROQ_API_KEY).toBe("sk-fail");
  });

  it("config.env sentinel rewrite: sensitive keys migrated and persisted", async () => {
    sandbox = createSandbox();
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);

    await fs.writeFile(
      sandbox.configEnvPath,
      [
        "OPENAI_API_KEY=sk-from-config-env",
        "LOG_LEVEL=info",
        "DISCORD_API_TOKEN=tok-discord",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );

    const result = await runVaultBootstrap({
      stateDir: sandbox.stateDir,
      vault: testVault.vault,
    });
    expect(result.failed).toEqual([]);
    expect(result.migrated).toBeGreaterThanOrEqual(2);

    const raw = await fs.readFile(sandbox.configEnvPath, "utf8");
    expect(raw).toContain("OPENAI_API_KEY=vault://OPENAI_API_KEY");
    expect(raw).toContain("DISCORD_API_TOKEN=vault://DISCORD_API_TOKEN");
    expect(raw).toContain("LOG_LEVEL=info");

    expect(await testVault.vault.get("OPENAI_API_KEY")).toBe(
      "sk-from-config-env",
    );
    expect(await testVault.vault.get("DISCORD_API_TOKEN")).toBe("tok-discord");
  });

  it("already-sentinel value is skipped, not double-migrated", async () => {
    sandbox = createSandbox();
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);
    await testVault.vault.set("OPENAI_API_KEY", "sk-pre-existing", {
      sensitive: true,
    });

    writeElizaJson(sandbox.configPath, {
      env: { OPENAI_API_KEY: "vault://OPENAI_API_KEY" },
    });

    const result = await runVaultBootstrap({
      stateDir: sandbox.stateDir,
      vault: testVault.vault,
    });
    expect(result.failed).toEqual([]);
    expect(result.migrated).toBe(0);

    const reread = await readJson<{ env: Record<string, string> }>(
      sandbox.configPath,
    );
    expect(reread.env.OPENAI_API_KEY).toBe("vault://OPENAI_API_KEY");
    expect(await testVault.vault.get("OPENAI_API_KEY")).toBe("sk-pre-existing");
  });

  it("non-sensitive keys are left alone in eliza.json", async () => {
    sandbox = createSandbox();
    testVault = await createTestVault();
    _resetSharedVaultForTesting(testVault.vault);

    writeElizaJson(sandbox.configPath, {
      env: { LOG_LEVEL: "debug", PORT: "31337" },
    });

    const result = await runVaultBootstrap({
      stateDir: sandbox.stateDir,
      vault: testVault.vault,
    });
    expect(result.migrated).toBe(0);
    expect(result.failed).toEqual([]);
    const reread = await readJson<{ env: Record<string, string> }>(
      sandbox.configPath,
    );
    expect(reread.env.LOG_LEVEL).toBe("debug");
    expect(reread.env.PORT).toBe("31337");
  });
});

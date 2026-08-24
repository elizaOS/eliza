/**
 * Integration coverage for startup wallet auto-provisioning. OS-store keys
 * survive a real restart through the durable vault, while a proven config
 * commit failure compensates vault writes and publishes no process env.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Vault } from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setConfigRenameSyncForTests } from "../config/config.ts";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import { startApiServer } from "./server.ts";
import { deriveEvmAddress } from "./wallet-keygen.ts";

const ENV_KEYS = [
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_STATE_DIR",
  "ELIZA_WALLET_AUTO_PROVISION",
  "ELIZA_WALLET_OS_STORE",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "SOLANA_PUBLIC_KEY",
  "WALLET_PUBLIC_KEY",
] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let stateDir = "";
let configPath = "";
let originalConfigBytes = "";
let vault: Vault & { entries: Map<string, string> };

function createVault(): Vault & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    set: async (key, value) => {
      entries.set(key, value);
    },
    setIfAbsent: async (key, value) => {
      if (entries.has(key)) return false;
      entries.set(key, value);
      return true;
    },
    setReference: async () => undefined,
    get: async (key) => {
      const value = entries.get(key);
      if (value === undefined) throw new Error(`vault miss: ${key}`);
      return value;
    },
    reveal: async (key) => {
      const value = entries.get(key);
      if (value === undefined) throw new Error(`vault miss: ${key}`);
      return value;
    },
    has: async (key) => entries.has(key),
    remove: async (key) => {
      entries.delete(key);
    },
    quarantineUnreadable: async () => false,
    list: async () => [...entries.keys()],
    describe: async () => null,
    stats: async () => ({
      total: entries.size,
      sensitive: entries.size,
      nonSensitive: 0,
      references: 0,
    }),
  };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
  for (const key of ENV_KEYS) delete process.env[key];
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-wallet-startup-"));
  configPath = path.join(stateDir, "eliza.json");
  originalConfigBytes = `${JSON.stringify({ logging: { level: "error" } }, null, 2)}\n`;
  fs.writeFileSync(configPath, originalConfigBytes);
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_WALLET_AUTO_PROVISION = "1";
  process.env.ELIZA_WALLET_OS_STORE = "true";
  vault = createVault();
  setAgentHostBridge({
    ...defaultAgentHostBridge,
    sharedVault: () => vault,
  });
});

afterEach(() => {
  __setConfigRenameSyncForTests(null);
  _resetAgentHostBridge();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("startup wallet auto-provisioning", () => {
  it("aborts without config or env publication when the wallet commit fails", async () => {
    __setConfigRenameSyncForTests(() => {
      const error = new Error(
        "wallet config write refused",
      ) as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    await expect(
      startApiServer({
        port: 0,
        skipDeferredStartupWork: true,
        skipListen: true,
      }),
    ).rejects.toMatchObject({ code: "AGENT_WALLET_PERSISTENCE_FAILED" });

    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfigBytes);
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PUBLIC_KEY).toBeUndefined();
    expect(process.env.WALLET_PUBLIC_KEY).toBeUndefined();
    expect(vault.entries.size).toBe(0);
  });

  it("restores identical OS-store wallet keys and addresses after restart", async () => {
    const first = await startApiServer({
      port: 0,
      skipDeferredStartupWork: true,
      skipListen: true,
    });
    const firstEvmPrivateKey = process.env.EVM_PRIVATE_KEY;
    const firstSolanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
    const firstEvmAddress = deriveEvmAddress(firstEvmPrivateKey ?? "");
    const firstSolanaAddress = process.env.SOLANA_PUBLIC_KEY;
    await first.close();

    expect(firstEvmPrivateKey).toBeTruthy();
    expect(firstSolanaPrivateKey).toBeTruthy();
    expect(firstSolanaAddress).toBeTruthy();
    expect(vault.entries.get("EVM_PRIVATE_KEY")).toBe(firstEvmPrivateKey);
    expect(vault.entries.get("SOLANA_PRIVATE_KEY")).toBe(firstSolanaPrivateKey);
    const durableBytes = fs.readFileSync(configPath, "utf8");
    expect(durableBytes).not.toContain(firstEvmPrivateKey ?? "missing");
    expect(durableBytes).not.toContain(firstSolanaPrivateKey ?? "missing");

    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.SOLANA_PUBLIC_KEY;
    delete process.env.WALLET_PUBLIC_KEY;

    const restarted = await startApiServer({
      port: 0,
      skipDeferredStartupWork: true,
      skipListen: true,
    });
    expect(process.env.EVM_PRIVATE_KEY).toBe(firstEvmPrivateKey);
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(firstSolanaPrivateKey);
    expect(deriveEvmAddress(process.env.EVM_PRIVATE_KEY ?? "")).toBe(
      firstEvmAddress,
    );
    expect(process.env.SOLANA_PUBLIC_KEY).toBe(firstSolanaAddress);
    await restarted.close();
  });
});

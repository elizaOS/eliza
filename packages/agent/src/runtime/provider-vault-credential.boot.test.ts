/**
 * Verifies that an unavailable selected-provider Vault prevents runtime and
 * chat readiness through the real `startEliza` boot boundary. The host Vault
 * is deterministic and no provider request is dispatched.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEliza } from "./eliza.ts";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "./host-bridge.ts";

const savedStateDir = process.env.ELIZA_STATE_DIR;
const savedProfileResolver = process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER;
const savedCerebrasKey = process.env.CEREBRAS_API_KEY;
const savedIntegrityKey = process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY;
let stateDir: string | null = null;

beforeEach(() => {
  delete process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY;
});

function createBootVault() {
  const entries = new Map<string, string>();
  return {
    ...defaultAgentHostBridge.sharedVault(),
    has: async (key: string) => entries.has(key),
    get: async (key: string) => {
      const value = entries.get(key);
      if (value === undefined)
        throw new Error(`Missing test Vault key: ${key}`);
      return value;
    },
    setIfAbsent: async (key: string, value: string) => {
      if (entries.has(key)) return false;
      entries.set(key, value);
      return true;
    },
  };
}

afterEach(async () => {
  _resetAgentHostBridge();
  if (savedStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = savedStateDir;
  if (savedProfileResolver === undefined) {
    delete process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER;
  } else {
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = savedProfileResolver;
  }
  if (savedCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = savedCerebrasKey;
  if (savedIntegrityKey === undefined) {
    delete process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY;
  } else {
    process.env.ELIZA_OPTIMIZED_PROMPT_HMAC_KEY = savedIntegrityKey;
  }
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("selected provider credential boot readiness", () => {
  it("constructs the runtime from a Vault-only credential without mutating process.env", async () => {
    stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-provider-vault-"),
    );
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = "1";
    delete process.env.CEREBRAS_API_KEY;

    const vault = createBootVault();
    const has = vi.fn(
      async (key: string) =>
        key === "providers.cerebras.api-key" || (await vault.has(key)),
    );
    const reveal = vi.fn(async (key: string) => {
      if (key !== "providers.cerebras.api-key") {
        throw new Error(`Unexpected test Vault reveal: ${key}`);
      }
      return "vault-only-cerebras-key";
    });
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      sharedVault: () => ({
        ...vault,
        has,
        reveal,
      }),
    });
    const abort = new AbortController();
    const onRuntimeCreated = vi.fn(
      (runtime: { getSetting: (key: string) => unknown }) => {
        expect(runtime.getSetting("CEREBRAS_API_KEY")).toBe(
          "vault-only-cerebras-key",
        );
        expect(process.env.CEREBRAS_API_KEY).toBeUndefined();
        abort.abort();
      },
    );

    await expect(
      startEliza({
        headless: true,
        abortSignal: abort.signal,
        onRuntimeCreated,
        configOverride: {
          firstRun: false,
          serviceRouting: {
            llmText: { backend: "cerebras", transport: "direct" },
          },
          agents: {
            defaults: {
              workspace: path.join(stateDir, "workspace"),
            },
          },
        } as never,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(onRuntimeCreated).toHaveBeenCalledOnce();
    expect(has).toHaveBeenCalledWith("providers.cerebras.api-key");
    expect(reveal).toHaveBeenCalledWith(
      "providers.cerebras.api-key",
      "runtime-boot:selected-provider-credential",
    );
    expect(process.env.CEREBRAS_API_KEY).toBeUndefined();
  });

  it("rejects before constructing a chat-ready runtime when Vault lookup fails", async () => {
    stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-provider-vault-"),
    );
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = "1";
    delete process.env.CEREBRAS_API_KEY;

    const cause = new Error("test Vault storage unavailable");
    const vault = createBootVault();
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      sharedVault: () => ({
        ...vault,
        has: vi.fn(async (key: string) => {
          if (key === "providers.cerebras.api-key") throw cause;
          return vault.has(key);
        }),
      }),
    });
    const onRuntimeCreated = vi.fn();

    await expect(
      startEliza({
        headless: true,
        onRuntimeCreated,
        configOverride: {
          firstRun: false,
          serviceRouting: {
            llmText: { backend: "cerebras", transport: "direct" },
          },
          agents: {
            defaults: {
              workspace: path.join(stateDir, "workspace"),
            },
          },
        } as never,
      }),
    ).rejects.toMatchObject({
      code: "SELECTED_PROVIDER_CREDENTIAL_UNAVAILABLE",
      severity: "fatal",
      context: {
        providerId: "cerebras",
        envKey: "CEREBRAS_API_KEY",
        stage: "lookup",
      },
      cause,
    });
    expect(onRuntimeCreated).not.toHaveBeenCalled();
  });
});

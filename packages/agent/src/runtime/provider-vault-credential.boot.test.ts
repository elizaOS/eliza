/**
 * Verifies that an unavailable selected-provider Vault prevents runtime and
 * chat readiness through the real `startEliza` boot boundary. The host Vault
 * is deterministic and no provider request is dispatched.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEliza } from "./eliza.ts";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "./host-bridge.ts";

const savedStateDir = process.env.ELIZA_STATE_DIR;
const savedProfileResolver = process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER;
const savedCerebrasKey = process.env.CEREBRAS_API_KEY;
let stateDir: string | null = null;

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
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("selected provider credential boot readiness", () => {
  it("rejects before constructing a chat-ready runtime when Vault lookup fails", async () => {
    stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-provider-vault-"),
    );
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = "1";
    delete process.env.CEREBRAS_API_KEY;

    const cause = new Error("test Vault storage unavailable");
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      sharedVault: () => ({
        ...defaultAgentHostBridge.sharedVault(),
        has: vi.fn(async (key: string) => {
          if (key === "providers.cerebras.api-key") throw cause;
          return false;
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

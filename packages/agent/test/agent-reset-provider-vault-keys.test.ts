/**
 * "Reset Agent" returns to first run; it must remove stored provider API keys
 * from the vault, otherwise boot hydration silently reuses the previous
 * owner's credential when that provider is selected again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import { profileStorageKey, setEntryMeta } from "@elizaos/auth/vault";
import { afterEach, beforeEach, expect, it } from "vitest";
import { handleAgentAdminRoutes } from "../src/api/agent-admin-routes.ts";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";
import { persistProviderApiKey } from "../src/runtime/operations/vault-bridge.ts";
import { hydrateSelectedProviderCredentialFromVault } from "../src/runtime/provider-vault-credential.ts";
import { applyVaultProfilesForAgent } from "../src/runtime/vault-profile-resolver.ts";

let stateDir: string;
let testVault: TestVault;
const savedEnv = { ...process.env };
const savedBridge = getAgentHostBridge();

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-reset-vault-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  delete process.env.ANTHROPIC_API_KEY;
  testVault = await createTestVault();
  setAgentHostBridge({ ...savedBridge, sharedVault: () => testVault.vault });
});

afterEach(async () => {
  setAgentHostBridge(savedBridge);
  await testVault.dispose();
  process.env = { ...savedEnv };
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function resetAgent(): Promise<number> {
  let status = 0;
  await handleAgentAdminRoutes({
    req: {},
    res: {},
    method: "POST",
    pathname: "/api/agent/reset",
    state: {
      runtime: null,
      config: {},
      agentState: "running",
      agentName: "Old",
      chatRoomId: null,
      chatUserId: null,
      chatConnectionReady: null,
      chatConnectionPromise: null,
      pendingRestartReasons: [],
    },
    json: (_res: unknown, _body: unknown, code = 200) => {
      status = code;
    },
    error: (_res: unknown, _message: string, code = 500) => {
      status = code;
    },
    resolveStateDir: () => stateDir,
    stateDirExists: () => false,
    removeStateDir: () => {},
    logWarn: () => {},
  } as never);
  return status;
}

it("removes stored provider API keys so boot cannot rehydrate them", async () => {
  const vault = testVault.vault;
  await persistProviderApiKey({
    secrets: { vault } as never,
    normalizedProvider: "anthropic",
    apiKey: "sk-ant-OLD-OWNER-KEY",
    caller: "test",
  });
  await vault.set("ANTHROPIC_API_KEY", "sk-ant-OLD-OWNER-KEY", {
    sensitive: true,
    caller: "test",
  });
  await vault.set(
    profileStorageKey("ANTHROPIC_API_KEY", "default"),
    "sk-ant-OLD-OWNER-PROFILE",
    { sensitive: true, caller: "test" },
  );
  await vault.set("ZAI_API_KEY", "zai-old-owner", {
    sensitive: true,
    caller: "test",
  });
  for (const key of ["GOOGLE_API_KEY", "KIMI_API_KEY"]) {
    await vault.set(key, `${key}-old-owner`, {
      sensitive: true,
      caller: "test",
    });
  }
  await setEntryMeta(vault, "ANTHROPIC_API_KEY", {
    profiles: [{ id: "default", label: "Default", createdAt: Date.now() }],
    activeProfile: "default",
  });
  fs.writeFileSync(
    process.env.ELIZA_CONFIG_PATH as string,
    JSON.stringify({
      meta: { firstRunComplete: true },
      env: { ANTHROPIC_API_KEY: "vault://ANTHROPIC_API_KEY" },
      serviceRouting: {
        llmText: { backend: "anthropic", transport: "direct" },
      },
      agents: {
        list: [{ id: "main", name: "Old" }],
        defaults: { workspace: path.join(stateDir, "workspace") },
      },
    }),
  );

  const status = await resetAgent();

  expect(status).toBe(200);
  expect(await vault.has("providers.anthropic.api-key")).toBe(false);
  expect(await vault.has("ANTHROPIC_API_KEY")).toBe(false);
  expect(await vault.has("ZAI_API_KEY")).toBe(false);
  expect(await vault.has("GOOGLE_API_KEY")).toBe(false);
  expect(await vault.has("KIMI_API_KEY")).toBe(false);
  const overlay: Record<string, string> = {};
  const hydration = await hydrateSelectedProviderCredentialFromVault({
    providerId: "anthropic",
    vault,
    env: {},
    settingsOverlay: overlay,
  });
  expect(hydration.status).toBe("missing");
  expect(overlay).toEqual({});
  await applyVaultProfilesForAgent(vault, "agent-after-reset");
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
});

it("reports a failed reset when a stored credential cannot be removed", async () => {
  const vault = testVault.vault;
  await vault.set("OPENAI_API_KEY", "sk-old", {
    sensitive: true,
    caller: "test",
  });
  setAgentHostBridge({
    ...savedBridge,
    sharedVault: () =>
      ({
        ...vault,
        has: (key: string) => vault.has(key),
        list: (prefix?: string) => vault.list(prefix),
        get: (key: string) => vault.get(key),
        set: vault.set.bind(vault),
        remove: async (key: string) => {
          if (key === "OPENAI_API_KEY") throw new Error("vault locked");
          return vault.remove(key);
        },
      }) as typeof vault,
  });

  expect(await resetAgent()).toBe(500);
  expect(await vault.has("OPENAI_API_KEY")).toBe(true);
});

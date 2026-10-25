/**
 * Clearing a credential through the secrets or plugin settings routes must
 * also drop the vault rows boot hydration reads, otherwise the key the owner
 * cleared is projected back into the runtime on the next restart.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import { profileStorageKey } from "@elizaos/auth/vault";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";
import { persistProviderApiKey } from "../src/runtime/operations/vault-bridge.ts";
import { hydrateSelectedProviderCredentialFromVault } from "../src/runtime/provider-vault-credential.ts";

let directory: string;
let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
let testVault: TestVault;
const token = randomUUID();
const fakeKey = "fake-openai-key-placeholder-not-a-secret";
const savedBridge = getAgentHostBridge();
const providerPlugins = [
  ["gemini", "GOOGLE_GENERATIVE_AI_API_KEY"],
  ["zai", "ZAI_API_KEY"],
] as const;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-secret-clear-vault-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  testVault = await createTestVault();
  setAgentHostBridge({ ...savedBridge, sharedVault: () => testVault.vault });
  const vault = testVault.vault;
  await persistProviderApiKey({
    secrets: { vault } as never,
    normalizedProvider: "openai",
    apiKey: fakeKey,
    caller: "test",
  });
  await vault.set("OPENAI_API_KEY", fakeKey, {
    sensitive: true,
    caller: "test",
  });
  await vault.set(profileStorageKey("OPENAI_API_KEY", "default"), fakeKey, {
    sensitive: true,
    caller: "test",
  });
  const installs: Record<string, { installPath: string; version: string }> = {};
  for (const [providerId, envKey] of providerPlugins) {
    const installPath = path.join(directory, "installs", providerId);
    await mkdir(installPath, { recursive: true });
    await writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify({
        name: `@elizaos/plugin-${providerId}`,
        version: "0.0.0",
        elizaos: { configKeys: [envKey] },
      }),
    );
    installs[`@elizaos/plugin-${providerId}`] = {
      installPath,
      version: "0.0.0",
    };
  }
  await writeFile(
    path.join(directory, "eliza.json"),
    JSON.stringify({
      env: { OPENAI_API_KEY: "vault://OPENAI_API_KEY" },
      serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
      plugins: {
        installs,
        entries: {
          openai: {
            enabled: true,
            config: { OPENAI_API_KEY: "vault://OPENAI_API_KEY" },
          },
        },
      },
    }),
  );
  server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
}, 120_000);

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  setAgentHostBridge(savedBridge);
  await testVault.dispose();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function request(route: string, method: string, body: object) {
  return fetch(`http://127.0.0.1:${server?.port}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function bootHydration() {
  const overlay: Record<string, string> = {};
  const hydration = await hydrateSelectedProviderCredentialFromVault({
    providerId: "openai",
    vault: testVault.vault,
    env: {},
    settingsOverlay: overlay,
  });
  return { status: hydration.status, overlay };
}

it.each([
  ["/api/secrets", { secrets: { OPENAI_API_KEY: "" } }],
  ["/api/plugins/openai", { config: { OPENAI_API_KEY: "" } }],
])(
  "clearing through PUT %s keeps the key from returning on the next boot",
  async (route, body) => {
    expect((await bootHydration()).status).toBe("hydrated");

    const cleared = await request(route, "PUT", body);
    expect(cleared.status, await cleared.clone().text()).toBe(200);

    const config = JSON.parse(
      await readFile(path.join(directory, "eliza.json"), "utf8"),
    );
    expect(config.env.OPENAI_API_KEY).toBeUndefined();
    expect(config.plugins.entries.openai.config.OPENAI_API_KEY).toBe("");

    await server?.close();
    server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
    expect(await bootHydration()).toEqual({ status: "missing", overlay: {} });
    expect(await testVault.vault.list("OPENAI_API_KEY")).toEqual([]);
    expect(await testVault.vault.has("providers.openai.api-key")).toBe(false);
  },
  120_000,
);

it.each(providerPlugins)(
  "clearing through PUT /api/plugins/%s removes its raw and canonical vault rows",
  async (providerId, envKey) => {
    const vault = testVault.vault;
    const placeholder = `fake-${providerId}-key-placeholder-not-a-secret`;
    await persistProviderApiKey({
      secrets: { vault } as never,
      normalizedProvider: providerId,
      apiKey: placeholder,
      caller: "test",
    });
    await vault.set(envKey, placeholder, { sensitive: true, caller: "test" });
    expect(await vault.has(`providers.${providerId}.api-key`)).toBe(true);

    const cleared = await request(`/api/plugins/${providerId}`, "PUT", {
      config: { [envKey]: "" },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);

    expect(await vault.list(envKey)).toEqual([]);
    expect(await vault.has(`providers.${providerId}.api-key`)).toBe(false);
  },
  120_000,
);

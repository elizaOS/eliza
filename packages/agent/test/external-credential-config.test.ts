import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { saveElizaConfig } from "../src/config/config.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function destination() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "external-config-"));
  directories.push(directory);
  const file = path.join(directory, "config.json");
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", file);
  return file;
}
it("persists ordinary settings without hydrated external credentials and preserves in-memory input", () => {
  const file = destination();
  const key = "fixture-host-held-cloud-secret";
  vi.stubEnv(
    "ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS",
    "EXTERNAL_CLOUD_TEST_KEY",
  );
  vi.stubEnv("EXTERNAL_CLOUD_TEST_KEY", key);
  const config = {
    cloud: { enabled: true, apiKey: key },
    env: { vars: { EXTERNAL_CLOUD_TEST_KEY: key, ORDINARY_SETTING: "kept" } },
  };
  saveElizaConfig(config);
  const bytes = fs.readFileSync(file, "utf8");
  expect(bytes).not.toContain(key);
  expect(JSON.parse(bytes).cloud.enabled).toBe(true);
  expect(JSON.parse(bytes).env.vars.ORDINARY_SETTING).toBe("kept");
  expect(config.cloud.apiKey).toBe(key);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  saveElizaConfig(config);
  expect(fs.readFileSync(file, "utf8")).not.toContain(key);
});
it("leaves unselected credentials unchanged and rejects malformed policy before replacing a file", () => {
  const file = destination();
  vi.stubEnv("ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS", "");
  saveElizaConfig({ cloud: { apiKey: "fixture-legacy-key" } });
  const before = fs.readFileSync(file, "utf8");
  expect(before).toContain("fixture-legacy-key");
  vi.stubEnv("ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS", "BAD NAME");
  expect(() => saveElizaConfig({ cloud: { apiKey: "replacement" } })).toThrow(
    "Invalid external config secret policy",
  );
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it("preserves saved and explicit connector options when connector credentials are persisted", async () => {
  const file = destination();
  const { prepareFirstRunConnectors } = await import("@elizaos/host/protocol");
  const { loadElizaConfig } = await import("../src/config/config.ts");
  const prepared = prepareFirstRunConnectors(
    {
      connectors: {
        telegram: { enabled: false, botToken: "old-telegram" },
        discord: { enabled: false, token: "old-discord" },
        whatsapp: { enabled: false, sessionPath: "/old/session" },
      },
    },
    {
      connectors: {
        telegram: { groupPolicy: "allowlist", botToken: "new-telegram" },
        discord: { token: "new-discord" },
        whatsapp: { sessionPath: "/new/session" },
      },
    },
  );
  if (!prepared.ok) throw new Error(prepared.error);
  saveElizaConfig({ connectors: prepared.connectors });
  expect(fs.existsSync(file)).toBe(true);
  expect(loadElizaConfig().connectors).toMatchObject({
    telegram: {
      enabled: false,
      botToken: "new-telegram",
      groupPolicy: "allowlist",
    },
    discord: { enabled: false, token: "new-discord" },
    whatsapp: { enabled: false, sessionPath: "/new/session" },
  });
});

it("keeps unavailable owner configuration distinct from an unset name", async () => {
  const file = destination();
  const { fetchConfiguredOwnerName, persistConfiguredOwnerName } = await import(
    "../src/services/owner-name.ts"
  );
  expect(await fetchConfiguredOwnerName()).toBeNull();
  expect(await persistConfiguredOwnerName("  Owner  ")).toBe(true);
  expect(await fetchConfiguredOwnerName()).toBe("Owner");
  fs.writeFileSync(file, "{broken");
  await expect(fetchConfiguredOwnerName()).rejects.toMatchObject({
    code: "OWNER_NAME_READ_FAILED",
  });
  await expect(persistConfiguredOwnerName("Replacement")).rejects.toMatchObject(
    { code: "OWNER_NAME_WRITE_FAILED" },
  );
  expect(fs.readFileSync(file, "utf8")).toBe("{broken");
});

it.each([
  { provider: "openai-api", strategy: "round-robin" },
  { provider: "openai-codex", strategy: "least-used" },
  { provider: "anthropic-subscription", strategy: "round-robin" },
] as const)(
  "applies authenticated $provider strategy changes to the live pool and durable config",
  async ({ provider, strategy }) => {
    const file = destination();
    vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
    vi.stubEnv("ELIZA_API_TOKEN", "strategy-route-test-token");
    vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
    const { DIRECT_ACCOUNT_PROVIDER_ENV } = await import("@elizaos/auth/auth");
    for (const key of new Set([
      ...Object.values(DIRECT_ACCOUNT_PROVIDER_ENV),
      "Z_AI_API_KEY",
      "KIMI_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ]))
      vi.stubEnv(key, "");
    const { applyAccountPoolApiCredentials, selectionForProvider } =
      await import("@elizaos/auth/accounts");
    const { AgentRuntime } = await import("@elizaos/core");
    const { SQLiteDatabaseAdapter } = await import("@elizaos/testing/runtime");
    const { getAgentHostBridge, setAgentHostBridge } = await import(
      "../src/runtime/host-bridge.ts"
    );
    const { startApiServer } = await import("../src/api/server.ts");
    const { loadElizaConfig } = await import("../src/config/config.ts");
    const savedBridge = getAgentHostBridge();
    setAgentHostBridge({ ...savedBridge, applyAccountPoolApiCredentials });
    const config = {
      env: { vars: { STRATEGY_FIXTURE_MARKER: "kept" } },
      accountStrategies: { [provider]: "priority" },
    };
    let runtime: InstanceType<typeof AgentRuntime> | undefined;
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    try {
      saveElizaConfig(config);
      await applyAccountPoolApiCredentials({
        accountStrategies: structuredClone(config.accountStrategies),
      });
      expect(selectionForProvider(provider).strategy).toBe("priority");
      runtime = new AgentRuntime({
        character: { name: "Strategy host", bio: [] },
        logLevel: "fatal",
        enableAutonomy: false,
      });
      runtime.registerDatabaseAdapter(
        SQLiteDatabaseAdapter.create(
          path.join(path.dirname(file), "state.sqlite"),
          runtime.agentId,
        ),
      );

      await runtime.init();
      server = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      const url = `http://127.0.0.1:${server.port}/api/providers/${provider}/strategy`;
      const patch = (value: string, authorized = true) =>
        fetch(url, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            ...(authorized
              ? { authorization: "Bearer strategy-route-test-token" }
              : {}),
          },
          body: JSON.stringify({ strategy: value }),
        });
      const denied = await patch(strategy, false);
      expect([401, 403]).toContain(denied.status);
      await denied.text();
      expect(selectionForProvider(provider).strategy).toBe("priority");
      expect(loadElizaConfig()).toMatchObject({
        accountStrategies: { [provider]: "priority" },
      });
      const applied = await patch(strategy);
      expect(applied.status).toBe(200);
      expect(await applied.json()).toEqual({ providerId: provider, strategy });
      expect(selectionForProvider(provider).strategy).toBe(strategy);
      expect(loadElizaConfig()).toMatchObject({
        accountStrategies: { [provider]: strategy },
      });
      const invalid = await patch("invalid-strategy");
      expect(invalid.status).toBe(400);
      await invalid.text();
      expect(selectionForProvider(provider).strategy).toBe(strategy);
      expect(loadElizaConfig()).toMatchObject({
        accountStrategies: { [provider]: strategy },
      });
    } finally {
      if (server) await server.close();
      if (runtime) await runtime.close();
      setAgentHostBridge(savedBridge);
      await applyAccountPoolApiCredentials();
    }
  },
  120_000,
);

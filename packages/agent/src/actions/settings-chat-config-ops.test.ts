/**
 * Exercises chat settings against a real temporary configuration store and
 * owner-world records. Provider, capability, and owner settings must persist;
 * invalid operations must fail explicitly. Runtime collaborators are fixtures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ActionResult,
  createMessageMemory,
  executePlannedToolCall,
  getSalt,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type Setting,
  saltWorldSettings,
  stringToUuid,
  unsaltWorldSettings,
  type World,
  type WorldSettings,
} from "@elizaos/core";
import {
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import { createMockRuntime } from "@elizaos/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsAction } from "./settings-actions.ts";

// A stub runtime is enough for the config-store ops (toggle_capability /
// update_ai_provider) — they read/write eliza.json and never touch the runtime.
// `character: {}` lets set_backend's live-character write-through no-op safely.
const RUNTIME = { character: {} } as unknown as IAgentRuntime;
const OWNER_MESSAGE = { entityId: "owner" } as unknown as Memory;

function invoke(parameters: Record<string, unknown>): Promise<ActionResult> {
  return settingsAction.handler(RUNTIME, OWNER_MESSAGE, undefined, {
    parameters,
  } as HandlerOptions) as Promise<ActionResult>;
}

let tempDir: string;
let configPath: string;
let priorConfigPath: string | undefined;
let priorPersistPath: string | undefined;
const AUTHORITY_ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
] as const;
const originalAuthorityEnv = Object.fromEntries(
  AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_ENV_KEYS) delete process.env[key];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-chat-ops-"));
  configPath = path.join(tempDir, "eliza.json");
  // Seed a minimal-but-real config so load/merge/save exercise the real path.
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ui: { capabilities: { wallet: false } } }),
  );
  priorConfigPath = process.env.ELIZA_CONFIG_PATH;
  priorPersistPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
  // Point BOTH the read resolver (ELIZA_CONFIG_PATH) and the write resolver
  // (ELIZA_PERSIST_CONFIG_PATH) at the temp file so load and save agree.
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
});

afterEach(() => {
  if (priorConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = priorConfigPath;
  if (priorPersistPath === undefined)
    delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  else process.env.ELIZA_PERSIST_CONFIG_PATH = priorPersistPath;
  for (const key of AUTHORITY_ENV_KEYS) {
    const value = originalAuthorityEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SETTINGS action — always available at the chat boundary", () => {
  it.each(["GUEST", "USER", "MEMBER"] as const)(
    "rejects %s before changing persisted settings",
    async (role) => {
      const before = fs.readFileSync(configPath, "utf8");
      const runtime = createMockRuntime({ actions: [settingsAction], logger });
      const result = await executePlannedToolCall(
        runtime,
        {
          message: createMessageMemory({
            entityId: stringToUuid("non-owner"),
            roomId: stringToUuid("settings-room"),
            content: { text: "Enable my wallet" },
          }),
          activeContexts: ["settings"],
          userRoles: [role],
        },
        {
          name: "SETTINGS",
          params: {
            action: "toggle_capability",
            capability: "wallet",
            enabled: true,
          },
        },
      );
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("not allowed");
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    },
  );

  it("validate() resolves true (gate is structural, not validate-time)", async () => {
    // SETTINGS has no validate-time preconditions — the OWNER gate is enforced
    // structurally by core (satisfiesRoleGate) before the handler runs, so the
    // action stays selectable and the gate can't be bypassed by a passing
    // validate.
    await expect(settingsAction.validate(RUNTIME, OWNER_MESSAGE)).resolves.toBe(
      true,
    );
  });
});

describe("SETTINGS update_ai_provider — persists to the real config store", () => {
  it.each([
    "staging-default",
    "offline",
    "staging-explicit",
    "production",
    "self-hosted",
  ] as const)(
    "rejects elizacloud under frozen %s authority before loading or mutating config",
    async (authority) => {
      const invalidConfig = "{ deliberately invalid config";
      fs.writeFileSync(configPath, invalidConfig);
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL =
        authority === "self-hosted"
          ? "https://private.example:8787/api/v1"
          : "https://api-staging.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY = "launch-key";
      process.env.ELIZAOS_CLOUD_ENABLED = "true";
      expect(resolveDevCloudEnvAuthority()).toBe(authority);

      process.env.ELIZAOS_CLOUD_API_KEY = "late-hostile-key";
      const environmentBefore = {
        apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
        enabled: process.env.ELIZAOS_CLOUD_ENABLED,
      };
      const result = await invoke({
        action: "update_ai_provider",
        provider: "elizacloud",
        apiKey: "request-key",
      });

      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({
        error: "DEV_CLOUD_AUTHORITY_ACTIVE",
        provider: "elizacloud",
        authority,
      });
      expect(fs.readFileSync(configPath, "utf-8")).toBe(invalidConfig);
      expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe(environmentBefore.apiKey);
      expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe(environmentBefore.enabled);
    },
  );

  it('"switch my model provider to openai" writes provider routing to eliza.json', async () => {
    const result = await invoke({
      action: "update_ai_provider",
      provider: "openai",
    });

    expect(result.success).toBe(true);
    expect(result.data?.op).toBe("update_ai_provider");
    expect(result.data?.provider).toBe("openai");
    expect(result.data?.requiresRestart).toBe(true);

    // The write actually landed on disk with the real provider routing the
    // running agent reads back — not a fabricated success.
    const config = readConfig();
    const routing = config.serviceRouting as
      | { llmText?: { backend?: string } }
      | undefined;
    expect(routing?.llmText?.backend).toBe("openai");
    const agents = config.agents as
      | { defaults?: { model?: { primary?: string } } }
      | undefined;
    expect(agents?.defaults?.model?.primary).toBe("@elizaos/plugin-openai");
  });

  it("carries an API key through to config when supplied", async () => {
    const result = await invoke({
      action: "update_ai_provider",
      provider: "openai",
      apiKey: "fixture-openai-api-token",
    });
    expect(result.success).toBe(true);
    // The key must be persisted somewhere reachable via config.env so the
    // switched provider can authenticate on the next boot.
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(raw).toContain("fixture-openai-api-token");
  });

  it("rejects a missing provider without touching the store", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await invoke({ action: "update_ai_provider" });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_PROVIDER");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("rejects an unknown provider with UNKNOWN_PROVIDER", async () => {
    const result = await invoke({
      action: "update_ai_provider",
      provider: "totally-not-a-provider",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("UNKNOWN_PROVIDER");
  });
});

describe("SETTINGS toggle_capability — persists to the real config store", () => {
  it("enabling the wallet capability flips config.ui.capabilities on disk", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });

    const config = readConfig();
    const capabilities = (
      config.ui as { capabilities?: Record<string, unknown> }
    )?.capabilities;
    expect(capabilities?.wallet).toBe(true);
  });

  it("disabling round-trips back to false on disk", async () => {
    await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: true,
    });
    const enabled = readConfig();
    expect(
      (enabled.ui as { capabilities?: Record<string, unknown> })?.capabilities
        ?.wallet,
    ).toBe(true);

    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: false,
    });
    expect(result.success).toBe(true);
    const config = readConfig();
    expect(
      (config.ui as { capabilities?: Record<string, unknown> })?.capabilities
        ?.wallet,
    ).toBe(false);
  });

  it("rejects an unknown capability with UNKNOWN_CAPABILITY", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "teleportation",
      enabled: true,
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("UNKNOWN_CAPABILITY");
  });

  it("rejects a non-boolean `enabled` with MISSING_ENABLED", async () => {
    const result = await invoke({
      action: "toggle_capability",
      capability: "wallet",
      enabled: "yes",
    });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_ENABLED");
  });
});

describe("SETTINGS set — legacy no-section branch (worldSettings registry)", () => {
  // Seed a real salted registry the way production writes it, so the handler
  // exercises the genuine unsalt → mutate → salt → updateWorld path.
  const GREETING_SETTING: Setting = {
    name: "Greeting",
    description: "Greeting the agent uses",
    usageDescription: "Greeting the agent uses",
    required: false,
    value: "hi",
    dependsOn: [],
  };

  function makeOwnerWorldRuntime(): {
    runtime: IAgentRuntime;
    updatedWorlds: World[];
  } {
    const salt = getSalt();
    const world = {
      id: "world-1",
      name: "Owner World",
      agentId: "agent-1",
      serverId: "server-1",
      metadata: {
        ownership: { ownerId: "owner" },
        settings: saltWorldSettings(
          { settings: { greeting: GREETING_SETTING } },
          salt,
        ),
      },
    } as unknown as World;
    const updatedWorlds: World[] = [];
    const runtime = {
      character: {},
      agentId: "agent-1",
      getAllWorlds: async () => [world],
      updateWorld: async (w: World) => {
        updatedWorlds.push(w);
      },
    } as unknown as IAgentRuntime;
    return { runtime, updatedWorlds };
  }

  it("routes { action:'set', key, value } to the worldSettings handler and persists (#14703 regression)", async () => {
    const { runtime, updatedWorlds } = makeOwnerWorldRuntime();
    const result = (await settingsAction.handler(
      runtime,
      OWNER_MESSAGE,
      undefined,
      {
        parameters: { action: "set", key: "greeting", value: "hello" },
      } as HandlerOptions,
    )) as ActionResult;

    // The regression routed this to the section handler, which failed with
    // "Tell me which settings section to change". The legacy branch succeeds
    // and reports the applied registry write.
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      actionName: "SETTINGS",
      op: "set",
      applied: [{ key: "greeting", value: "hello" }],
    });

    expect(updatedWorlds).toHaveLength(1);
    const persisted = updatedWorlds[0].metadata?.settings as WorldSettings;
    const unsalted = unsaltWorldSettings(persisted, getSalt());
    expect(unsalted.settings?.greeting?.value).toBe("hello");
  });

  it("still fails with the legacy error shape for an unknown registry key", async () => {
    const { runtime, updatedWorlds } = makeOwnerWorldRuntime();
    const result = (await settingsAction.handler(
      runtime,
      OWNER_MESSAGE,
      undefined,
      {
        parameters: { action: "set", key: "bogus", value: "x" },
      } as HandlerOptions,
    )) as ActionResult;
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("NO_VALID_UPDATES");
    expect(updatedWorlds).toHaveLength(0);
  });
});

describe("SETTINGS dispatch — unknown op fails explicitly", () => {
  it("returns SETTINGS_INVALID (never a fabricated success) for an unknown action", async () => {
    const result = await invoke({ action: "frobnicate" });
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_INVALID");
  });

  it("returns SETTINGS_INVALID when no action discriminator is supplied", async () => {
    const result = await invoke({});
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("SETTINGS_INVALID");
  });
});

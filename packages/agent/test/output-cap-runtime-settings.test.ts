/**
 * A host that configures the agent through its environment sets the runtime's
 * per-model-type output caps, so a text-generation call that sends no cap of
 * its own stops holding a hosted provider's largest output reservation. A cap
 * in the config or on the character outranks the environment's.
 */
import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConfigRoutes } from "../src/api/config-routes.ts";
import {
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  isBlockedEnvKey,
} from "../src/api/plugin-discovery-helpers.ts";
import {
  isBlockedObjectKey,
  redactConfigSecrets,
  stripRedactedPlaceholderValuesDeep,
} from "../src/api/server-helpers-config.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { clearConfigEnvValue } from "../src/config/env-vars.ts";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";
import { buildRuntimeSettingsProjection } from "../src/runtime/runtime-settings.ts";

const SMALL = "TEXT_SMALL_MAX_TOKENS";

describe("output caps projected from the environment", () => {
  it("projects a cap for every text-generation model type", () => {
    const env = {
      TEXT_NANO_MAX_TOKENS: "256",
      TEXT_SMALL_MAX_TOKENS: "1024",
      TEXT_MEDIUM_MAX_TOKENS: "2048",
      TEXT_LARGE_MAX_TOKENS: "4096",
      TEXT_MEGA_MAX_TOKENS: "8192",
      RESPONSE_HANDLER_MAX_TOKENS: "3000",
      ACTION_PLANNER_MAX_TOKENS: "5000",
      REASONING_SMALL_MAX_TOKENS: "6000",
      REASONING_LARGE_MAX_TOKENS: "7000",
      TEXT_COMPLETION_MAX_TOKENS: "512",
    };
    expect(buildRuntimeSettingsProjection({}, { env })).toMatchObject(env);
  });

  it("projects the integer, not the text around it", () => {
    const settings = buildRuntimeSettingsProjection(
      {},
      { env: { [SMALL]: " 04096 " } },
    );
    expect(settings[SMALL]).toBe("4096");
  });

  // The runtime reads a blank setting as a cap of zero output tokens.
  it.each(["", "   ", "0", "-1", "4096.5", "1e3", "0x10", "lots"])(
    "projects no cap from the value %j",
    (value) => {
      const settings = buildRuntimeSettingsProjection(
        {},
        { env: { [SMALL]: value } },
      );
      expect(settings).not.toHaveProperty(SMALL);
    },
  );

  // The runtime applies DEFAULT_MAX_TOKENS to every model type's calls.
  it("projects neither DEFAULT_MAX_TOKENS nor a cap for a model type that generates no text", () => {
    const settings = buildRuntimeSettingsProjection(
      {},
      {
        env: {
          DEFAULT_MAX_TOKENS: "4096",
          TEXT_EMBEDDING_MAX_TOKENS: "4096",
          IMAGE_DESCRIPTION_MAX_TOKENS: "4096",
          TRANSCRIPTION_MAX_TOKENS: "4096",
        },
      },
    );
    expect(
      Object.keys(settings).filter((key) => /_MAX_TOKENS$/.test(key)),
    ).toEqual([]);
  });

  it("lets a cap in the config replace the environment's", () => {
    const env = { [SMALL]: "4096", TEXT_LARGE_MAX_TOKENS: "8192" };
    const settings = buildRuntimeSettingsProjection(
      { env: { [SMALL]: "2048" } },
      { env },
    );
    expect(settings[SMALL]).toBe("2048");
    expect(settings.TEXT_LARGE_MAX_TOKENS).toBe("8192");
  });

  it("lets a cap on the character outrank the environment's", () => {
    const settings = buildRuntimeSettingsProjection(
      {},
      { env: { [SMALL]: "4096", TEXT_LARGE_MAX_TOKENS: "8192" } },
    );
    const runtime = new AgentRuntime({
      character: {
        name: "output-cap-precedence",
        bio: [],
        settings: { [SMALL]: "1024" },
      },
      settings,
      logLevel: "fatal",
    });
    expect(runtime.getSetting(SMALL)).toBe("1024");
    expect(runtime.getSetting("TEXT_LARGE_MAX_TOKENS")).toBe("8192");
  });
});

describe("output caps on a running agent", () => {
  /** A config env key that is not an output cap. */
  const UNRELATED = "ELIZA_PROACTIVE_INTERACTIONS";
  let dir: string | undefined;
  let booted: AgentRuntime | undefined;

  afterEach(async () => {
    await booted?.close();
    booted = undefined;
    clearConfigEnvValue(SMALL);
    clearConfigEnvValue(UNRELATED);
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * Boot an agent whose environment caps TEXT_SMALL at 4096. `put` patches
   * the config through PUT /api/config; `reload` saves a config env to disk
   * and applies it through POST /api/config/reload.
   */
  async function bootWithEnvironmentCap(
    agentSettings: Record<string, string> = {},
  ) {
    dir = await mkdtemp(path.join(tmpdir(), "output-cap-settings-"));
    const configPath = path.join(dir, "eliza.json");
    vi.stubEnv("ELIZA_STATE_DIR", dir);
    vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
    vi.stubEnv(UNRELATED, undefined);
    vi.stubEnv(SMALL, "4096");
    const agents = {
      list: [
        { id: "main", default: true, name: "Eliza", settings: agentSettings },
      ],
    };
    saveElizaConfig({ agents });
    const bootConfig = loadElizaConfig();
    const runtime = new AgentRuntime({
      character: buildCharacterFromConfig(bootConfig),
      settings: buildRuntimeSettingsProjection(bootConfig, {
        env: process.env,
      }),
      logLevel: "fatal",
    });
    booted = runtime;
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(
        path.join(dir, "state.sqlite"),
        runtime.agentId,
      ),
    );
    await runtime.init();
    const config = loadElizaConfig();
    const request = async (
      method: "PUT" | "POST",
      pathname: string,
      body: Record<string, unknown>,
    ) => {
      let status = 0;
      await handleConfigRoutes({
        req: {} as http.IncomingMessage,
        res: {} as http.ServerResponse,
        method,
        pathname,
        url: new URL(`http://localhost${pathname}`),
        config,
        runtime,
        json: (_res, _data, code = 200) => {
          status = code;
        },
        error: (_res, message) => {
          throw new Error(message);
        },
        readJsonBody: async <T extends object>() => body as T,
        redactConfigSecrets,
        isBlockedObjectKey,
        stripRedactedPlaceholderValuesDeep,
        patchTouchesProviderSelection: () => false,
        isBlockedEnvKey,
        CONFIG_WRITE_ALLOWED_TOP_KEYS,
        resolveMcpServersRejection: async () => null,
        resolveMcpTerminalAuthorizationRejection: () => null,
      });
      expect(status).toBe(200);
    };
    return {
      runtime,
      put: (env: Record<string, string>) =>
        request("PUT", "/api/config", { env }),
      reload: (env: Record<string, string>) => {
        saveElizaConfig({ agents, env });
        return request("POST", "/api/config/reload", {});
      },
      /** The cap a runtime built now, from the saved config, would start with. */
      rebuilt: () =>
        buildRuntimeSettingsProjection(loadElizaConfig(), {
          env: process.env,
        })[SMALL],
    };
  }

  // A running agent keeps the cap it started with: the config's cap outranks
  // the environment's from the next start, when the settings are built again.
  it.each(["put", "reload"] as const)(
    "starts with the environment's cap and takes a cap the config adds on %s when it next starts",
    async (route) => {
      const agent = await bootWithEnvironmentCap();
      const { runtime, rebuilt } = agent;
      expect(runtime.getSetting(SMALL)).toBe("4096");

      await agent[route]({ [UNRELATED]: "off" });
      expect(runtime.getSetting(SMALL)).toBe("4096");

      await agent[route]({ [SMALL]: "2048" });
      expect(runtime.getSetting(SMALL)).toBe("4096");
      expect(rebuilt()).toBe("2048");
    },
  );

  it("keeps the character's cap when the config adds one", async () => {
    const { runtime, put } = await bootWithEnvironmentCap({ [SMALL]: "512" });
    expect(runtime.getSetting(SMALL)).toBe("512");

    await put({ [SMALL]: "2048" });
    expect(runtime.getSetting(SMALL)).toBe("512");
  });
});

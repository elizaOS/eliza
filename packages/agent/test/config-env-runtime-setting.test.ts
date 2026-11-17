import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { getDefaultStylePreset } from "@elizaos/host/protocol";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { buildVoiceConfigForCharacterEntry } from "../../ui/src/components/character/character-voice-config.ts";
import { resolveCharacterVoiceConfigFromAppConfig } from "../../ui/src/voice/character-voice-config.ts";
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
import {
  buildRuntimeSettingsProjection,
  hydrateConfigEnvForBoot,
} from "../src/runtime/runtime-settings.ts";

const KEY = "ELIZA_PROACTIVE_INTERACTIONS";

it("applies a changed or cleared config env setting to the running agent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "config-env-runtime-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  vi.stubEnv(KEY, "chatty");
  saveElizaConfig({
    agents: { list: [{ id: "main", default: true, name: "Eliza" }] },
    env: { [KEY]: "chatty" },
  });
  const bootConfig = loadElizaConfig();
  const runtime = new AgentRuntime({
    character: buildCharacterFromConfig(bootConfig),
    settings: buildRuntimeSettingsProjection(bootConfig, { env: process.env }),
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      path.join(dir, "state.sqlite"),
      runtime.agentId,
    ),
  );
  const config = loadElizaConfig();
  const put = async (patch: Record<string, unknown>) => {
    let status = 0;
    await handleConfigRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "PUT",
      pathname: "/api/config",
      url: new URL("http://localhost/api/config"),
      config,
      runtime,
      json: (_res, _data, code = 200) => {
        status = code;
      },
      error: (_res, message) => {
        throw new Error(message);
      },
      readJsonBody: async <T extends object>() => patch as T,
      redactConfigSecrets,
      isBlockedObjectKey,
      stripRedactedPlaceholderValuesDeep,
      patchTouchesProviderSelection: () => false,
      isBlockedEnvKey,
      CONFIG_WRITE_ALLOWED_TOP_KEYS,
      resolveMcpServersRejection: async () => null,
      resolveMcpTerminalAuthorizationRejection: () => null,
    });
    return status;
  };
  try {
    await runtime.init();
    expect(runtime.getSetting(KEY)).toBe("chatty");

    expect(await put({ env: { [KEY]: "off" } })).toBe(200);
    expect(loadElizaConfig().env?.[KEY]).toBe("off");
    expect(process.env[KEY]).toBe("off");
    expect(runtime.getSetting(KEY)).toBe("off");

    expect(await put({ env: { [KEY]: "" } })).toBe(200);
    expect(process.env[KEY]).toBeUndefined();
    expect(runtime.getSetting(KEY)).toBeNull();

    const preset = getDefaultStylePreset("en");
    const selected = buildVoiceConfigForCharacterEntry({
      entry: {
        id: preset.id,
        name: preset.name,
        avatarIndex: preset.avatarIndex,
        voicePresetId: "brian",
        preset,
      },
      useElevenLabs: true,
      voiceConfig: {
        provider: "elevenlabs",
        mode: "own-key",
        elevenlabs: { modelId: "owner-model", stability: 0.3 },
      },
    });
    if (!selected) throw new Error("Voice selection did not resolve");
    expect(
      await put({ messages: { tts: selected.persistedVoiceConfig } }),
    ).toBe(200);
    expect(loadElizaConfig().messages?.tts?.elevenlabs).toMatchObject({
      voiceId: "8dEUmyPMdDdK91vboYih",
      modelId: "owner-model",
      stability: 0.3,
    });
    for (const voiceId of ["owner-selected-voice", "nPczCjzI2devNBz1zQrb"]) {
      const explicit = {
        ...selected.persistedVoiceConfig,
        elevenlabs: { ...selected.persistedVoiceConfig.elevenlabs, voiceId },
      };
      expect(await put({ messages: { tts: explicit } })).toBe(200);
      const stored = loadElizaConfig();
      expect(
        resolveCharacterVoiceConfigFromAppConfig({
          config: { ...stored, ui: { presetId: preset.id } },
          uiLanguage: "en",
        })?.elevenlabs?.voiceId,
      ).toBe(voiceId);
    }
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it("applies a changed or cleared config env setting on POST /api/config/reload", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "config-env-reload-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  vi.stubEnv(KEY, "chatty");
  const agents = { list: [{ id: "main", default: true, name: "Eliza" }] };
  saveElizaConfig({ agents, env: { [KEY]: "chatty" } });
  const bootConfig = loadElizaConfig();
  const runtime = new AgentRuntime({
    character: buildCharacterFromConfig(bootConfig),
    settings: buildRuntimeSettingsProjection(bootConfig, { env: process.env }),
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      path.join(dir, "state.sqlite"),
      runtime.agentId,
    ),
  );
  const config = loadElizaConfig();
  const reload = async () => {
    let body: unknown;
    await handleConfigRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "POST",
      pathname: "/api/config/reload",
      url: new URL("http://localhost/api/config/reload"),
      config,
      runtime,
      json: (_res, data) => {
        body = data;
      },
      error: (_res, message) => {
        throw new Error(message);
      },
      readJsonBody: async <T extends object>() => ({}) as T,
      redactConfigSecrets,
      isBlockedObjectKey,
      stripRedactedPlaceholderValuesDeep,
      patchTouchesProviderSelection: () => false,
      isBlockedEnvKey,
      CONFIG_WRITE_ALLOWED_TOP_KEYS,
      resolveMcpServersRejection: async () => null,
      resolveMcpTerminalAuthorizationRejection: () => null,
    });
    return body;
  };
  try {
    await runtime.init();
    expect(runtime.getSetting(KEY)).toBe("chatty");

    saveElizaConfig({ agents, env: { [KEY]: "off" } });
    expect(await reload()).toEqual({
      reloaded: true,
      applied: ["env"],
      requiresRestart: [],
    });
    expect(runtime.getSetting(KEY)).toBe("off");

    saveElizaConfig({ agents, env: {} });
    expect(await reload()).toEqual({
      reloaded: true,
      applied: ["env"],
      requiresRestart: [],
    });
    expect(runtime.getSetting(KEY)).toBeNull();
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["boot", "reload", "operator", "override"])(
  "clears only config-owned provider credentials after %s",
  async (mode) => {
    const KEY = "OPENAI_API_KEY";
    const dir = await mkdtemp(path.join(tmpdir(), "config-env-reload-"));
    const configPath = path.join(dir, "eliza.json");
    vi.stubEnv("ELIZA_STATE_DIR", dir);
    vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
    vi.stubEnv(KEY, mode === "operator" ? "chatty" : undefined);
    const agents = { list: [{ id: "main", default: true, name: "Eliza" }] };
    saveElizaConfig({ agents, env: { [KEY]: "chatty" } });
    const bootConfig = loadElizaConfig();
    hydrateConfigEnvForBoot(bootConfig);
    const runtime = new AgentRuntime({
      character: buildCharacterFromConfig(bootConfig),
      settings: buildRuntimeSettingsProjection(bootConfig, {
        env: process.env,
      }),
      logLevel: "fatal",
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(
        path.join(dir, "state.sqlite"),
        runtime.agentId,
      ),
    );
    const config = loadElizaConfig();
    const reload = async () => {
      let body: unknown;
      await handleConfigRoutes({
        req: {} as http.IncomingMessage,
        res: {} as http.ServerResponse,
        method: "POST",
        pathname: "/api/config/reload",
        url: new URL("http://localhost/api/config/reload"),
        config,
        runtime,
        json: (_res, data) => {
          body = data;
        },
        error: (_res, message) => {
          throw new Error(message);
        },
        readJsonBody: async <T extends object>() => ({}) as T,
        redactConfigSecrets,
        isBlockedObjectKey,
        stripRedactedPlaceholderValuesDeep,
        patchTouchesProviderSelection: () => false,
        isBlockedEnvKey,
        CONFIG_WRITE_ALLOWED_TOP_KEYS,
        resolveMcpServersRejection: async () => null,
        resolveMcpTerminalAuthorizationRejection: () => null,
      });
      return body;
    };
    try {
      await runtime.init();
      expect(runtime.getSetting(KEY)).toBe("chatty");

      if (mode === "reload") {
        saveElizaConfig({ agents, env: { [KEY]: "rotated" } });
        await reload();
        expect(process.env[KEY]).toBe("rotated");
      }
      if (mode === "override") process.env[KEY] = "operator-override";

      saveElizaConfig({ agents, env: {} });
      expect(await reload()).toEqual({
        reloaded: true,
        applied: expect.arrayContaining(["env"]),
        requiresRestart: [],
      });
      expect(process.env[KEY]).toBe(
        mode === "operator"
          ? "chatty"
          : mode === "override"
            ? "operator-override"
            : undefined,
      );
      if (mode === "boot" || mode === "reload") {
        expect(runtime.getSetting(KEY)).toBeNull();
      }
    } finally {
      await runtime.close();
      clearConfigEnvValue(KEY);
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

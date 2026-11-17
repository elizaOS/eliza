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
import { resolveEffectiveVoiceConfig } from "../../ui/src/voice/voice-chat-types.ts";
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
    const voiceConfig: Parameters<
      typeof buildVoiceConfigForCharacterEntry
    >[0]["voiceConfig"] = {
      provider: "elevenlabs",
      mode: "own-key",
      elevenlabs: { modelId: "owner-model", stability: 0.3 },
    };
    const implicit = resolveEffectiveVoiceConfig(voiceConfig);
    expect(await put({ messages: { tts: implicit } })).toBe(200);
    expect(loadElizaConfig().messages?.tts?.elevenlabs).toEqual({
      modelId: "owner-model",
      stability: 0.3,
      similarityBoost: 0.75,
      speed: 1,
    });
    for (const [voicePresetId, voiceId] of [
      ["sarah", "OZ0L6eISlOejga3XjDFt"],
      ["matilda", "QtY3JBOUKEB5xzrRfOKc"],
      ["lily", "22N9cF8z0o7y23njdyaY"],
      ["alice", "BFd5oBc2DDna33pSi4Gf"],
      ["brian", "8dEUmyPMdDdK91vboYih"],
      ["daniel", "fnYMz3F5gMEDGMWcH1ex"],
      ["liam", "ktkP7Nsj67dw2zcplQYt"],
      ["callum", "fs2OqxduwXgp9foh2xjK"],
    ]) {
      const selected = buildVoiceConfigForCharacterEntry({
        entry: {
          id: preset.id,
          name: preset.name,
          avatarIndex: preset.avatarIndex,
          voicePresetId,
          preset,
        },
        useElevenLabs: true,
        voiceConfig,
      });
      if (!selected) throw new Error("Voice selection did not resolve");
      expect(
        await put({ messages: { tts: selected.persistedVoiceConfig } }),
      ).toBe(200);
      expect(loadElizaConfig().messages?.tts?.elevenlabs).toMatchObject({
        voiceId,
        modelId: "owner-model",
        stability: 0.3,
      });
    }
    for (const voiceId of [
      "owner-selected-voice",
      "EXAVITQu4vr4xnSDxMaL",
      "XrExE9yKIg1WjnnlVkGX",
      "pFZP5JQG7iQjIQuC4Bku",
      "Xb7hH8MSUJpSbSDYk0k2",
      "nPczCjzI2devNBz1zQrb",
      "onwK4e9ZLuTAKqWW03F9",
      "TX3LPaxmHKxFdv7VOQHJ",
      "N2lVS1w4EtoT3dr4eOWO",
    ]) {
      const explicit = {
        ...voiceConfig,
        elevenlabs: { ...voiceConfig.elevenlabs, voiceId },
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

    for (const [presetId, voiceId, resolvedVoiceId] of [
      ["rin", "QtY3JBOUKEB5xzrRfOKc", "QtY3JBOUKEB5xzrRfOKc"],
      ["satoshi", "8dEUmyPMdDdK91vboYih", "8dEUmyPMdDdK91vboYih"],
      ["momo", "OZ0L6eISlOejga3XjDFt", "OZ0L6eISlOejga3XjDFt"],
      ["yuki", "22N9cF8z0o7y23njdyaY", "22N9cF8z0o7y23njdyaY"],
      ["momo", "BFd5oBc2DDna33pSi4Gf", "BFd5oBc2DDna33pSi4Gf"],
      ["ryu", "fnYMz3F5gMEDGMWcH1ex", "fnYMz3F5gMEDGMWcH1ex"],
      ["jin", "ktkP7Nsj67dw2zcplQYt", "ktkP7Nsj67dw2zcplQYt"],
      ["kei", "fs2OqxduwXgp9foh2xjK", "fs2OqxduwXgp9foh2xjK"],
      ["rin", "owner-selected-voice", "owner-selected-voice"],
      ["jin", "pNInz6obpgDQGcFmaJgB", "6IwYbsNENZgAB1dtBZDp"],
      ["kei", "TxGEqnHWrfWFTfGW9XjX", "eadgjmk4R4uojdsheG9t"],
      ["momo", "Xb7hH8MSUJpSbSDYk0k2", "n7Wi4g1bhpw4Bs8HK5ph"],
      ["rin", "XrExE9yKIg1WjnnlVkGX", "cNYrMw9glwJZXR8RwbuR"],
      ["ryu", "onwK4e9ZLuTAKqWW03F9", "QzTKubutNn9TjrB7Xb2Q"],
      ["satoshi", "nPczCjzI2devNBz1zQrb", "7cOBG34AiHrAzs842Rdi"],
      ["yuki", "pFZP5JQG7iQjIQuC4Bku", "4tRn1lSkEn13EVTuqb0g"],
    ]) {
      const elevenlabs = { voiceId, modelId: "owner-model", stability: 0.3 };
      saveElizaConfig({
        agents,
        env: {},
        ui: { presetId },
        messages: { tts: { provider: "elevenlabs", elevenlabs } },
      });
      await reload();
      const stored = loadElizaConfig();
      expect(stored.messages?.tts?.elevenlabs).toEqual(elevenlabs);
      expect(stored.messages?.tts?.mode).toBeUndefined();
      expect(
        resolveCharacterVoiceConfigFromAppConfig({
          config: { ...stored },
          uiLanguage: "en",
        })?.elevenlabs,
      ).toMatchObject({ ...elevenlabs, voiceId: resolvedVoiceId });
    }
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

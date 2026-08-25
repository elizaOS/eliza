/**
 * Colocated coverage for the first-run API helpers. Drives the real module:
 * deprecated-field detection, credential persist, default-agent write, replay
 * body derivation, and cloud-provisioned detection. Config writes use a
 * throwaway ELIZA_STATE_DIR; process.env is restored per test. Collaborators
 * are not mocked.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent";
import { stringToUuid } from "@elizaos/core";
import { getDefaultStylePreset, getStylePresets } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveFirstRunReplayBody,
  extractAndPersistFirstRunApiKey,
  hasDeprecatedFirstRunRequestFields,
  isCloudProvisioned,
  persistFirstRunDefaults,
} from "./server-first-run-helpers";

const DEPRECATED_KEYS = [
  "connection",
  "runMode",
  "cloudProvider",
  "provider",
  "providerApiKey",
  "primaryModel",
  "smallModel",
  "largeModel",
] as const;

const CONFIG_ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_HOME",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
] as const;

const CLOUD_ENV_KEYS = [
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
] as const;

const CREDENTIAL_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

const ALL_ISOLATED_ENV_KEYS = [
  ...CONFIG_ENV_KEYS,
  ...CLOUD_ENV_KEYS,
  ...CREDENTIAL_ENV_KEYS,
] as const;

const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
const SARAH_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const JIN_VOICE_ID = "6IwYbsNENZgAB1dtBZDp";

function snapshotEnv(
  keys: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearEnv(keys: readonly string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  throw new Error("expected a persisted object record");
}

describe("hasDeprecatedFirstRunRequestFields", () => {
  it("is false for an empty body", () => {
    expect(hasDeprecatedFirstRunRequestFields({})).toBe(false);
  });

  it("is false when only current first-run keys are present", () => {
    expect(
      hasDeprecatedFirstRunRequestFields({
        name: "Scout",
        credentialInputs: { llmApiKey: "sk-test" },
        deploymentTarget: { runtime: "local" },
        serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
      }),
    ).toBe(false);
  });

  it.each([...DEPRECATED_KEYS])(
    "is true when %s is an own property, even with an undefined value",
    (key) => {
      expect(hasDeprecatedFirstRunRequestFields({ [key]: undefined })).toBe(
        true,
      );
    },
  );

  it("is true when several deprecated keys are present together", () => {
    expect(
      hasDeprecatedFirstRunRequestFields({
        provider: "openai",
        primaryModel: "gpt-4o",
        name: "Scout",
      }),
    ).toBe(true);
  });

  it("ignores inherited prototype keys and only counts Object.hasOwn", () => {
    const proto = { provider: "openai", runMode: "cloud" };
    const body = Object.create(proto) as Record<string, unknown>;
    expect(hasDeprecatedFirstRunRequestFields(body)).toBe(false);
    body.connection = "legacy";
    expect(hasDeprecatedFirstRunRequestFields(body)).toBe(true);
  });
});

describe("deriveFirstRunReplayBody", () => {
  it("copies an empty body and is not cloud mode", () => {
    const body: Record<string, unknown> = {};
    const result = deriveFirstRunReplayBody(body);
    expect(result.isCloudMode).toBe(false);
    expect(result.replayBody).toEqual({});
    expect(result.replayBody).not.toBe(body);
  });

  it("preserves unrelated fields on a shallow copy without mutating the original", () => {
    const nested = { keep: true };
    const body: Record<string, unknown> = {
      name: "Scout",
      extra: nested,
    };
    const result = deriveFirstRunReplayBody(body);
    expect(result.replayBody.name).toBe("Scout");
    expect(result.replayBody.extra).toBe(nested);
    result.replayBody.name = "Mutated";
    expect(body.name).toBe("Scout");
  });

  it("sets isCloudMode only when the normalized runtime is cloud", () => {
    expect(
      deriveFirstRunReplayBody({ deploymentTarget: { runtime: "cloud" } })
        .isCloudMode,
    ).toBe(true);
    expect(
      deriveFirstRunReplayBody({ deploymentTarget: { runtime: "local" } })
        .isCloudMode,
    ).toBe(false);
    expect(
      deriveFirstRunReplayBody({ deploymentTarget: { runtime: "remote" } })
        .isCloudMode,
    ).toBe(false);
  });

  it("replaces a valid deploymentTarget with the normalized record", () => {
    const result = deriveFirstRunReplayBody({
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
        ignored: "drop-me",
      },
    });
    expect(result.isCloudMode).toBe(true);
    expect(result.replayBody.deploymentTarget).toEqual({
      runtime: "cloud",
      provider: "elizacloud",
    });
  });

  it("leaves an invalid deploymentTarget on the spread copy (normalize returns null)", () => {
    const invalid = { runtime: "nope" };
    const result = deriveFirstRunReplayBody({ deploymentTarget: invalid });
    expect(result.isCloudMode).toBe(false);
    expect(result.replayBody.deploymentTarget).toBe(invalid);
  });

  it("normalizes credentialInputs and trims secrets", () => {
    const result = deriveFirstRunReplayBody({
      credentialInputs: { llmApiKey: "  sk-live  ", unused: 1 },
    });
    expect(result.replayBody.credentialInputs).toEqual({
      llmApiKey: "sk-live",
    });
  });

  it("drops redacted or empty credentialInputs from the replacement and keeps the spread original when normalize returns null", () => {
    const empty = {};
    const emptyResult = deriveFirstRunReplayBody({ credentialInputs: empty });
    expect(emptyResult.replayBody.credentialInputs).toBe(empty);

    const redacted = { llmApiKey: "[REDACTED]" };
    const redactedResult = deriveFirstRunReplayBody({
      credentialInputs: redacted,
    });
    expect(redactedResult.replayBody.credentialInputs).toBe(redacted);
  });

  it("normalizes linkedAccounts and serviceRouting when they survive validation", () => {
    const result = deriveFirstRunReplayBody({
      linkedAccounts: {
        openai: { status: "linked", source: "api-key" },
        "  ": { status: "linked" },
      },
      serviceRouting: {
        llmText: { backend: "openai", transport: "direct" },
        ignored: true,
      },
    });
    expect(result.replayBody.linkedAccounts).toEqual({
      openai: { status: "linked", source: "api-key" },
    });
    expect(result.replayBody.serviceRouting).toEqual({
      llmText: { backend: "openai", transport: "direct" },
    });
  });

  it("leaves empty linkedAccounts and empty serviceRouting as the spread originals", () => {
    const linkedAccounts = {};
    const serviceRouting = {};
    const result = deriveFirstRunReplayBody({
      linkedAccounts,
      serviceRouting,
    });
    expect(result.replayBody.linkedAccounts).toBe(linkedAccounts);
    expect(result.replayBody.serviceRouting).toBe(serviceRouting);
  });
});

describe("isCloudProvisioned", () => {
  const previous = snapshotEnv(CLOUD_ENV_KEYS);

  beforeEach(() => {
    clearEnv(CLOUD_ENV_KEYS);
  });

  afterEach(() => {
    restoreEnv(previous);
  });

  it("is false when the cloud flag and every token source are missing", () => {
    expect(isCloudProvisioned()).toBe(false);
  });

  it("is false when the flag is 1 but no platform token is configured", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(isCloudProvisioned()).toBe(false);
  });

  it("is false when a platform token exists but the flag is not exactly 1", () => {
    process.env.STEWARD_AGENT_TOKEN = "steward";
    process.env.ELIZA_CLOUD_PROVISIONED = "0";
    expect(isCloudProvisioned()).toBe(false);
    process.env.ELIZA_CLOUD_PROVISIONED = "true";
    expect(isCloudProvisioned()).toBe(false);
    process.env.ELIZA_CLOUD_PROVISIONED = "2";
    expect(isCloudProvisioned()).toBe(false);
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    expect(isCloudProvisioned()).toBe(false);
  });

  it("trims the aliased flag so surrounding whitespace still counts as 1", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "  1  ";
    process.env.STEWARD_AGENT_TOKEN = "steward";
    expect(isCloudProvisioned()).toBe(true);
  });

  it("is true when the flag is 1 and STEWARD_AGENT_TOKEN is non-empty", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(isCloudProvisioned()).toBe(true);
  });

  it("treats a whitespace-only steward token as missing", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "   ";
    expect(isCloudProvisioned()).toBe(false);
  });

  it("is true when the flag is 1 and ELIZA_API_TOKEN resolves to a compat token", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_API_TOKEN = "Bearer compat-token";
    expect(isCloudProvisioned()).toBe(true);
  });

  it("is true when the flag is 1 and cloud API-key provisioning is enabled", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
    process.env.ELIZAOS_CLOUD_API_KEY = "  ck-live  ";
    expect(isCloudProvisioned()).toBe(true);
  });

  it("does not treat cloud API-key provisioning as sufficient without the exact enabled flag and a trimmed key", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZAOS_CLOUD_ENABLED = "TRUE";
    process.env.ELIZAOS_CLOUD_API_KEY = "ck-live";
    expect(isCloudProvisioned()).toBe(false);

    process.env.ELIZAOS_CLOUD_ENABLED = "true";
    process.env.ELIZAOS_CLOUD_API_KEY = "   ";
    expect(isCloudProvisioned()).toBe(false);

    delete process.env.ELIZAOS_CLOUD_API_KEY;
    expect(isCloudProvisioned()).toBe(false);

    process.env.ELIZAOS_CLOUD_ENABLED = "false";
    process.env.ELIZAOS_CLOUD_API_KEY = "ck-live";
    expect(isCloudProvisioned()).toBe(false);
  });
});

describe("persistFirstRunDefaults and extractAndPersistFirstRunApiKey", () => {
  const previous = snapshotEnv(ALL_ISOLATED_ENV_KEYS);
  let stateDir: string;
  let configPath: string;

  function pinConfigEnv(): void {
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_HOME = stateDir;
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  }

  beforeEach(() => {
    clearEnv(ALL_ISOLATED_ENV_KEYS);
    stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "server-first-run-helpers-"),
    );
    configPath = path.join(stateDir, "eliza.json");
    pinConfigEnv();
  });

  afterEach(() => {
    restoreEnv(previous);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function readConfig(): Record<string, unknown> {
    pinConfigEnv();
    return asRecord(loadElizaConfig());
  }

  function seedConfig(patch: Record<string, unknown>): void {
    pinConfigEnv();
    const config = asRecord(loadElizaConfig());
    Object.assign(config, patch);
    saveElizaConfig(config);
  }

  describe("persistFirstRunDefaults", () => {
    it("returns null and writes nothing when name is missing, blank, or not a string", () => {
      expect(persistFirstRunDefaults({})).toBeNull();
      expect(persistFirstRunDefaults({ name: "   " })).toBeNull();
      expect(persistFirstRunDefaults({ name: 12 })).toBeNull();
      expect(fs.existsSync(configPath)).toBe(false);
    });

    it("returns the deterministic admin entity id for the trimmed name", () => {
      const adminEntityId = persistFirstRunDefaults({ name: "  Scout  " });
      expect(adminEntityId).toBe(stringToUuid("Scout-admin-entity"));
    });

    it("creates agents.defaults, a main list entry, and ui.assistant from a bare name", () => {
      const defaultPreset = getDefaultStylePreset("en");
      const adminEntityId = persistFirstRunDefaults({ name: "Scout" });
      const config = readConfig();
      const agents = asRecord(config.agents);
      const defaults = asRecord(agents.defaults);
      const list = agents.list as Record<string, unknown>[];
      const ui = asRecord(config.ui);

      expect(defaults.adminEntityId).toBe(adminEntityId);
      expect(list).toEqual([{ id: "main", default: true, name: "Scout" }]);
      expect(asRecord(ui.assistant).name).toBe("Scout");
      expect(ui.language).toBe("en");
      expect(ui.avatarIndex).toBe(defaultPreset.avatarIndex);
      expect(ui.presetId).toBe(defaultPreset.id);
      expect(config.messages).toBeUndefined();
    });

    it("writes optional character fields only when they match the type gates", () => {
      persistFirstRunDefaults({
        name: "Scout",
        bio: ["first", "second"],
        systemPrompt: "  Be brief.  ",
        style: { all: ["direct"] },
        adjectives: ["dry"],
        topics: ["planning"],
        postExamples: ["ship it"],
        messageExamples: [[{ user: "user", content: { text: "hi" } }]],
      });
      const entry = (
        asRecord(readConfig().agents).list as Record<string, unknown>[]
      )[0];
      expect(entry.bio).toEqual(["first", "second"]);
      expect(entry.system).toBe("Be brief.");
      expect(entry.style).toEqual({ all: ["direct"] });
      expect(entry.adjectives).toEqual(["dry"]);
      expect(entry.topics).toEqual(["planning"]);
      expect(entry.postExamples).toEqual(["ship it"]);
      expect(entry.messageExamples).toEqual([
        [{ user: "user", content: { text: "hi" } }],
      ]);
    });

    it("skips optional character fields that fail the type gates, including a whitespace system prompt", () => {
      persistFirstRunDefaults({
        name: "Scout",
        bio: "not-an-array",
        systemPrompt: "   ",
        style: "not-an-object",
        adjectives: "nope",
        topics: { topic: true },
        postExamples: null,
        messageExamples: undefined,
      });
      const entry = (
        asRecord(readConfig().agents).list as Record<string, unknown>[]
      )[0];
      expect(entry.bio).toBeUndefined();
      expect(entry.system).toBeUndefined();
      expect(entry.style).toBeUndefined();
      expect(entry.adjectives).toBeUndefined();
      expect(entry.topics).toBeUndefined();
      expect(entry.postExamples).toBeUndefined();
      expect(entry.messageExamples).toBeUndefined();
    });

    it("writes a style array because arrays are objects, but skips null style", () => {
      persistFirstRunDefaults({ name: "Scout", style: ["chat"] });
      expect(
        (asRecord(readConfig().agents).list as Record<string, unknown>[])[0]
          .style,
      ).toEqual(["chat"]);

      persistFirstRunDefaults({ name: "Scout", style: null });
      expect(
        (asRecord(readConfig().agents).list as Record<string, unknown>[])[0]
          .style,
      ).toEqual(["chat"]);
    });

    it("resolves style by presetId before avatarIndex and name", () => {
      const jin = getStylePresets("en").find((preset) => preset.id === "jin");
      if (!jin) {
        throw new Error("expected the jin style preset");
      }
      process.env.ELEVENLABS_API_KEY = "elabs-live";
      persistFirstRunDefaults({
        name: "Chen",
        presetId: "jin",
        avatarIndex: 1,
      });
      const config = readConfig();
      const ui = asRecord(config.ui);
      // Own-body fields win on ui even when they disagree with the resolved preset.
      expect(ui.presetId).toBe("jin");
      expect(ui.avatarIndex).toBe(1);
      expect(
        (asRecord(config.agents).list as Record<string, unknown>[])[0].name,
      ).toBe("Chen");
      // Voice comes from the resolved jin preset, not Chen/Eliza (avatarIndex 1).
      const tts = asRecord(asRecord(config.messages).tts);
      expect(asRecord(tts.elevenlabs).voiceId).toBe(JIN_VOICE_ID);
      expect(jin.voicePresetId).toBe("jin");
    });

    it("keeps an unknown own presetId on ui even when style falls through", () => {
      persistFirstRunDefaults({
        name: "Scout",
        presetId: "not-a-preset",
        avatarIndex: 2,
      });
      const ui = asRecord(readConfig().ui);
      expect(ui.presetId).toBe("not-a-preset");
      expect(ui.avatarIndex).toBe(2);
    });

    it("resolves style by avatarIndex, first-wins, and skips non-finite indexes", () => {
      persistFirstRunDefaults({ name: "Scout", avatarIndex: 1 });
      expect(asRecord(readConfig().ui).presetId).toBe("eliza");

      persistFirstRunDefaults({ name: "Scout", avatarIndex: 2 });
      expect(asRecord(readConfig().ui).presetId).toBe("jin");

      persistFirstRunDefaults({ name: "Scout", avatarIndex: Number.NaN });
      expect(asRecord(readConfig().ui).presetId).toBe("eliza");

      persistFirstRunDefaults({
        name: "Scout",
        avatarIndex: Number.POSITIVE_INFINITY,
      });
      expect(asRecord(readConfig().ui).presetId).toBe("eliza");
    });

    it("resolves style by exact trimmed agent name when presetId and avatarIndex miss", () => {
      persistFirstRunDefaults({ name: "  Jin  " });
      expect(asRecord(readConfig().ui).presetId).toBe("jin");

      persistFirstRunDefaults({ name: "jin" });
      expect(asRecord(readConfig().ui).presetId).toBe("eliza");
    });

    it("normalizes language and writes a body avatarIndex even when no preset matches it", () => {
      persistFirstRunDefaults({
        name: "Scout",
        language: "zh-hans",
        avatarIndex: 99,
      });
      const ui = asRecord(readConfig().ui);
      expect(ui.language).toBe("zh-CN");
      expect(ui.avatarIndex).toBe(99);
      expect(ui.presetId).toBe(getDefaultStylePreset("zh-CN").id);
    });

    it("replaces a missing or empty agents.list and mutates the first existing entry in place", () => {
      seedConfig({
        agents: {
          defaults: { extra: true },
          list: [{ id: "kept", default: true, name: "Old" }],
        },
        ui: { assistant: { extra: "stay" }, theme: "dark" },
      });
      persistFirstRunDefaults({ name: "Scout" });
      const config = readConfig();
      const agents = asRecord(config.agents);
      const list = agents.list as Record<string, unknown>[];
      expect(list[0]).toEqual({ id: "kept", default: true, name: "Scout" });
      expect(asRecord(agents.defaults).extra).toBe(true);
      const ui = asRecord(config.ui);
      expect(ui.theme).toBe("dark");
      expect(asRecord(ui.assistant)).toEqual({ extra: "stay", name: "Scout" });

      seedConfig({ agents: { list: [] } });
      persistFirstRunDefaults({ name: "Scout" });
      expect(asRecord(readConfig().agents).list).toEqual([
        { id: "main", default: true, name: "Scout" },
      ]);
    });

    it("writes ElevenLabs TTS when an API key and a mapped voice are both present", () => {
      process.env.ELEVENLABS_API_KEY = "elabs-live";
      persistFirstRunDefaults({ name: "Scout" });
      const messages = asRecord(readConfig().messages);
      const tts = asRecord(messages.tts);
      expect(tts.provider).toBe("elevenlabs");
      expect(asRecord(tts.elevenlabs)).toEqual({
        voiceId: SARAH_VOICE_ID,
        modelId: DEFAULT_ELEVENLABS_TTS_MODEL,
      });
    });

    it("uses the jin voice id when the resolved preset is jin", () => {
      process.env.ELEVENLABS_API_KEY = "elabs-live";
      persistFirstRunDefaults({ name: "Jin" });
      const tts = asRecord(asRecord(readConfig().messages).tts);
      expect(asRecord(tts.elevenlabs).voiceId).toBe(JIN_VOICE_ID);
    });

    it("does not write TTS when the ElevenLabs key is missing or whitespace", () => {
      persistFirstRunDefaults({ name: "Scout" });
      expect(readConfig().messages).toBeUndefined();

      process.env.ELEVENLABS_API_KEY = "   ";
      persistFirstRunDefaults({ name: "Scout" });
      expect(readConfig().messages).toBeUndefined();
    });

    it("preserves a non-empty existing ElevenLabs modelId and replaces whitespace with the default", () => {
      process.env.ELEVENLABS_API_KEY = "elabs-live";
      seedConfig({
        messages: {
          tts: {
            extra: true,
            elevenlabs: { modelId: "eleven_multilingual_v2", extraVoice: 1 },
          },
        },
      });
      persistFirstRunDefaults({ name: "Scout" });
      let tts = asRecord(asRecord(readConfig().messages).tts);
      expect(tts.extra).toBe(true);
      expect(asRecord(tts.elevenlabs)).toEqual({
        modelId: "eleven_multilingual_v2",
        extraVoice: 1,
        voiceId: SARAH_VOICE_ID,
      });

      seedConfig({
        messages: { tts: { elevenlabs: { modelId: "   " } } },
      });
      persistFirstRunDefaults({ name: "Scout" });
      tts = asRecord(asRecord(readConfig().messages).tts);
      expect(asRecord(tts.elevenlabs).modelId).toBe(
        DEFAULT_ELEVENLABS_TTS_MODEL,
      );
    });
  });

  describe("extractAndPersistFirstRunApiKey", () => {
    it("returns null when the body has no resolvable credentials", async () => {
      await expect(extractAndPersistFirstRunApiKey({})).resolves.toBeNull();
      await expect(
        extractAndPersistFirstRunApiKey({
          credentialInputs: {},
          serviceRouting: {
            llmText: { backend: "openai", transport: "direct" },
          },
        }),
      ).resolves.toBeNull();
      await expect(
        extractAndPersistFirstRunApiKey({
          credentialInputs: { llmApiKey: "   " },
        }),
      ).resolves.toBeNull();
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    });

    it("persists a real direct OpenAI key and returns OPENAI_API_KEY", async () => {
      const result = await extractAndPersistFirstRunApiKey({
        credentialInputs: { llmApiKey: "sk-typed-777" },
        serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
      });
      expect(result).toBe("OPENAI_API_KEY");
      const env = asRecord(readConfig().env);
      expect(asRecord(env.vars).OPENAI_API_KEY).toBe("sk-typed-777");
    });

    it("refuses a masked key when nothing is resolvable locally", async () => {
      const seeded = await extractAndPersistFirstRunApiKey({
        credentialInputs: { llmApiKey: "sk-real-abc123" },
        serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
      });
      expect(seeded).toBe("OPENAI_API_KEY");
      delete process.env.OPENAI_API_KEY;

      const result = await extractAndPersistFirstRunApiKey({
        credentialInputs: { llmApiKey: "****ab12" },
        serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
      });
      expect(result).toBeNull();
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      const env = asRecord(readConfig().env);
      expect(asRecord(env.vars).OPENAI_API_KEY).toBe("sk-real-abc123");
    });

    it("persists a cloud API key but returns null because the transport is not direct", async () => {
      const result = await extractAndPersistFirstRunApiKey({
        credentialInputs: { cloudApiKey: "ck-cloud-1" },
        deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
        serviceRouting: {
          llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        },
      });
      expect(result).toBeNull();
      expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("ck-cloud-1");
      expect(asRecord(readConfig().cloud).apiKey).toBe("ck-cloud-1");
    });
  });
});

import { describe, expect, test } from "vitest";
import {
  applyNativeCloudRuntimeProfile,
  applyNativeRuntimeProfileEnvironment,
  MISSED_OCCURRENCES_ENV,
  NATIVE_RUNTIME_PROFILES,
  type NativeRuntimeProfileStores,
  nativeCloudServiceRouting,
  nativeRuntimeRoutingPreferences,
  parseNativeCloudRuntimeDeclaration,
  resolveNativeRuntimeProfile,
} from "./native-runtime-profile.js";

const API_BASE = "https://cloud.example.com/api/v1";
const MODEL = "cerebras/qwen-3.8-27b";

function env(profile?: string): NodeJS.ProcessEnv {
  return {
    ...(profile === undefined ? {} : { ELIZA_RUNTIME_PROFILE: profile }),
    ELIZAOS_CLOUD_BASE_URL: API_BASE,
    ELIZAOS_CLOUD_SMALL_MODEL: MODEL,
    ELIZAOS_CLOUD_LARGE_MODEL: MODEL,
  };
}

function stores(initial: Record<string, unknown>) {
  const state: { saved?: Record<string, unknown>; routing?: unknown } = {};
  const value: NativeRuntimeProfileStores = {
    loadConfig: () => structuredClone(initial),
    saveConfig: (config) => {
      state.saved = structuredClone(config);
    },
    updateRoutingPreferences: async (update) => {
      state.routing = update({
        preferredProvider: { TEXT_EMBEDDING: "eliza-local-inference" },
        policy: { TEXT_EMBEDDING: "prefer-local" },
      });
    },
  };
  return { value, state };
}

describe("native runtime profiles", () => {
  test("the default native profile keeps embeddings and speech on the device", () => {
    for (const selection of [undefined, "", "native"])
      expect(resolveNativeRuntimeProfile(selection)).toBe(
        NATIVE_RUNTIME_PROFILES.native,
      );
    expect(NATIVE_RUNTIME_PROFILES.native).toMatchObject({
      textInference: "elizacloud",
      embeddings: "local",
      agentSpeech: "local-only",
      localModels: true,
    });
    expect(
      nativeCloudServiceRouting(NATIVE_RUNTIME_PROFILES.native, {
        small: MODEL,
        large: MODEL,
      }).embeddings,
    ).toEqual({ backend: "eliza-local-inference", transport: "direct" });
  });

  test("the explicit Cloud QA profile is distinct and carries no local models", () => {
    const cloud = resolveNativeRuntimeProfile("cloud");
    expect(cloud).toMatchObject({
      embeddings: "elizacloud",
      localModels: false,
    });
    expect(
      nativeCloudServiceRouting(cloud, { small: MODEL, large: MODEL })
        .embeddings,
    ).toMatchObject({ backend: "elizacloud", transport: "cloud-proxy" });
    // Cloud QA speech is a disclosed host upload, never an agent fallback.
    expect(cloud.agentSpeech).toBe("local-only");
  });

  test("unknown profiles fail closed", () => {
    for (const selection of ["hosted", "Cloud", "native "])
      expect(() => resolveNativeRuntimeProfile(selection)).toThrow(
        /Unknown native runtime profile/,
      );
  });

  test("text routes use the bound Cloud models for every tier", () => {
    const { llmText } = nativeCloudServiceRouting(
      NATIVE_RUNTIME_PROFILES.native,
      { small: "small-model", large: "large-model" },
    );
    expect(llmText).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
      nanoModel: "small-model",
      smallModel: "small-model",
      mediumModel: "small-model",
      responseHandlerModel: "small-model",
      largeModel: "large-model",
      megaModel: "large-model",
      actionPlannerModel: "large-model",
    });
  });

  test("routing preferences pin text and speech while keeping other owner choices", () => {
    const next = nativeRuntimeRoutingPreferences(
      NATIVE_RUNTIME_PROFILES.native,
      {
        preferredProvider: { TEXT_EMBEDDING: "eliza-local-inference" },
        policy: { TEXT_EMBEDDING: "prefer-local", TRANSCRIPTION: "cloud-only" },
      },
    );
    expect(next).toEqual({
      preferredProvider: {
        TEXT_EMBEDDING: "eliza-local-inference",
        TEXT_SMALL: "elizacloud",
        TEXT_LARGE: "elizacloud",
      },
      policy: {
        TEXT_EMBEDDING: "prefer-local",
        TEXT_SMALL: "manual",
        TEXT_LARGE: "manual",
        TRANSCRIPTION: "local-only",
        TEXT_TO_SPEECH: "local-only",
      },
    });
  });

  test("a declaration names exactly one canonical HTTPS Cloud API base", () => {
    expect(
      parseNativeCloudRuntimeDeclaration({ apiBaseUrl: API_BASE }),
    ).toEqual({ apiBaseUrl: API_BASE });
    for (const value of [
      undefined,
      [],
      { apiBaseUrl: "http://cloud.example.com/api/v1" },
      { apiBaseUrl: "https://user:pw@cloud.example.com/api/v1" },
      { apiBaseUrl: "https://cloud.example.com:8443/api/v1" },
      { apiBaseUrl: "https://cloud.example.com/api/v1/" },
      { apiBaseUrl: "https://cloud.example.com/api/v2" },
      { apiBaseUrl: "https://cloud.example.com/api/v1?x=1" },
      { apiBaseUrl: API_BASE, extra: true },
    ])
      expect(() => parseNativeCloudRuntimeDeclaration(value)).toThrow(
        /declaration is invalid/,
      );
  });
});

describe("applying a profile before boot", () => {
  test("writes canonical routing, drops a shadowing desktop key and keeps other routes", async () => {
    const { value, state } = stores({
      cloud: { apiKey: "desktop-key", inferenceMode: "cloud" },
      serviceRouting: {
        embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
        tts: { backend: "local" },
      },
      other: true,
    });
    const profile = await applyNativeCloudRuntimeProfile(
      env("native"),
      { apiBaseUrl: API_BASE },
      value,
    );
    expect(profile.id).toBe("native");
    expect(state.saved).toMatchObject({
      other: true,
      cloud: { inferenceMode: "cloud", enabled: true, baseUrl: API_BASE },
      serviceRouting: {
        // A previous Cloud QA embedding route cannot persist into native.
        embeddings: { backend: "eliza-local-inference", transport: "direct" },
        tts: { backend: "local" },
        llmText: { backend: "elizacloud", smallModel: MODEL },
      },
    });
    expect(state.saved?.cloud).not.toHaveProperty("apiKey");
    expect(state.routing).toMatchObject({
      preferredProvider: {
        TEXT_EMBEDDING: "eliza-local-inference",
        TEXT_SMALL: "elizacloud",
      },
      policy: { TEXT_EMBEDDING: "prefer-local", TRANSCRIPTION: "local-only" },
    });
  });

  test("the Cloud QA profile writes the Cloud embedding route", async () => {
    const { value, state } = stores({});
    await applyNativeCloudRuntimeProfile(
      env("cloud"),
      { apiBaseUrl: API_BASE },
      value,
    );
    expect(state.saved).toMatchObject({
      serviceRouting: {
        embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    });
  });

  test("an incomplete or foreign binding writes nothing", async () => {
    const cases: NodeJS.ProcessEnv[] = [
      { ...env(), ELIZAOS_CLOUD_SMALL_MODEL: "" },
      { ...env(), ELIZAOS_CLOUD_LARGE_MODEL: undefined },
      { ...env(), ELIZAOS_CLOUD_BASE_URL: "https://other.example.com/api/v1" },
      env("hosted"),
    ];
    for (const input of cases) {
      const { value, state } = stores({});
      await expect(
        applyNativeCloudRuntimeProfile(input, { apiBaseUrl: API_BASE }, value),
      ).rejects.toThrow();
      expect(state.saved).toBeUndefined();
      expect(state.routing).toBeUndefined();
    }
  });
});

describe("process policy at resident boot", () => {
  test("a selected profile records missed scheduled occurrences", () => {
    // The trigger runtime and workflow service read this shared setting.
    expect(MISSED_OCCURRENCES_ENV).toBe("ELIZA_MISSED_SCHEDULED_OCCURRENCES");
    for (const selection of ["native", "cloud", ""]) {
      const input: NodeJS.ProcessEnv = { ELIZA_RUNTIME_PROFILE: selection };
      expect(
        applyNativeRuntimeProfileEnvironment(input)?.missedOccurrences,
      ).toBe("record");
      expect(input[MISSED_OCCURRENCES_ENV]).toBe("record");
    }
  });

  test("a host without a profile keeps its behavior and an unknown one fails closed", () => {
    const untouched: NodeJS.ProcessEnv = {};
    expect(applyNativeRuntimeProfileEnvironment(untouched)).toBeUndefined();
    expect(untouched).toEqual({});
    expect(() =>
      applyNativeRuntimeProfileEnvironment({ ELIZA_RUNTIME_PROFILE: "hosted" }),
    ).toThrow(/Unknown native runtime profile/);
  });
});

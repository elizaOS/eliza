import { ModelType, validateToolArgs } from "@elizaos/core";
import { normalizeFirstRunProviderId } from "@elizaos/host/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsAction } from "./settings-actions.ts";

describe("SETTINGS updates parameter", () => {
  it("accepts the documented `{ key, value }` bulk-write entries", () => {
    expect(
      validateToolArgs(settingsAction, {
        action: "set",
        updates: [
          { key: "OPENAI_API_KEY", value: "sk-test" },
          { key: "TWITTER_USERNAME", value: "eliza" },
        ],
      }),
    ).toEqual({
      valid: true,
      args: {
        action: "set",
        updates: [
          { key: "OPENAI_API_KEY", value: "sk-test" },
          { key: "TWITTER_USERNAME", value: "eliza" },
        ],
      },
      errors: [],
    });
  });

  it("accepts boolean and number setting values", () => {
    expect(
      validateToolArgs(settingsAction, {
        action: "set",
        updates: [
          { key: "FEATURE_X", value: true },
          { key: "MAX_TOKENS", value: 4096 },
        ],
      }),
    ).toEqual({
      valid: true,
      args: {
        action: "set",
        updates: [
          { key: "FEATURE_X", value: true },
          { key: "MAX_TOKENS", value: 4096 },
        ],
      },
      errors: [],
    });
  });

  it("rejects an entry without a value", () => {
    expect(
      validateToolArgs(settingsAction, {
        action: "set",
        updates: [{ key: "X" }],
      }),
    ).toEqual({
      valid: false,
      args: undefined,
      errors: ["Missing required argument 'updates[0].value'"],
      invalidParameterNames: ["updates"],
    });
  });
});

describe("SETTINGS single-value and model slot parameters", () => {
  it("accepts a boolean or number `value` for a single set", () => {
    for (const value of [true, 4096, "eliza"]) {
      expect(
        validateToolArgs(settingsAction, {
          action: "set",
          key: "FEATURE_X",
          value,
        }),
      ).toEqual({
        valid: true,
        args: { action: "set", key: "FEATURE_X", value },
        errors: [],
      });
    }
  });

  it("accepts the model slots the update_ai_provider handler reads", () => {
    const args = {
      action: "update_ai_provider",
      provider: "openai",
      modelConfigs: { primary: "gpt-5", large: "gpt-5", nano: "gpt-5-nano" },
    };
    expect(validateToolArgs(settingsAction, args)).toEqual({
      valid: true,
      args,
      errors: [],
    });
  });

  it("advertises only provider ids the update_ai_provider handler accepts", () => {
    const description = settingsAction.parameters?.find(
      (parameter) => parameter.name === "provider",
    )?.description;
    const ids = /\(([^)]+)\)/.exec(description ?? "")?.[1]?.split(", ") ?? [];
    expect(ids).toContain("cerebras");
    expect(ids).not.toContain("anthropic-subscription");
    for (const id of ids) {
      expect(normalizeFirstRunProviderId(id), id).toBe(id);
    }
  });

  it("rejects a model slot the handler does not read", () => {
    expect(
      validateToolArgs(settingsAction, {
        action: "update_ai_provider",
        provider: "openai",
        modelConfigs: { huge: "gpt-5" },
      }).valid,
    ).toBe(false);
  });
});

const configMocks = vi.hoisted(() => ({
  load: vi.fn(() => ({}) as Record<string, unknown>),
  save: vi.fn(),
}));
vi.mock("../config/config.ts", () => ({
  loadElizaConfig: configMocks.load,
  saveElizaConfig: configMocks.save,
  resolveConfigWritePath: () => "/nonexistent/eliza.json",
}));
vi.mock("../services/owner-name.ts", () => ({
  fetchConfiguredOwnerName: vi.fn(async () => null),
  persistConfiguredOwnerName: vi.fn(async () => true),
}));

function fakeRuntime() {
  return {
    character: { settings: {} },
    getSetting: vi.fn(() => null),
    setSetting: vi.fn(),
    models: new Map([[ModelType.TEXT_LARGE, [{ provider: "openai" }]]]),
  };
}

async function runSettings(
  runtime: ReturnType<typeof fakeRuntime>,
  parameters: Record<string, unknown>,
) {
  const handler = settingsAction.handler;
  if (!handler) throw new Error("SETTINGS handler is missing");
  const result = await handler(
    runtime as never,
    { entityId: "owner" } as never,
    undefined,
    { parameters } as never,
    undefined,
  );
  if (!result) throw new Error("SETTINGS returned nothing");
  return result;
}

const API_KEY = "sk-test-secret-key-0123";

describe("SETTINGS under ELIZA_HOST_OPERATION_POLICY=product", () => {
  beforeEach(() => {
    configMocks.load.mockImplementation(() => ({}));
    configMocks.save.mockReset();
    vi.stubEnv("ELIZA_HOST_OPERATION_POLICY", "product");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { action: "update_ai_provider", provider: "openai", apiKey: API_KEY },
    { action: "set_backend", axis: "brain", backend: "openai" },
    { action: "set_backend", backend: "codex" },
    { action: "toggle_capability", capability: "wallet", enabled: false },
  ])("refuses $action without writing anything", async (parameters) => {
    const runtime = fakeRuntime();
    const result = await runSettings(runtime, parameters);
    expect(result.success).toBe(false);
    expect(result.text).toContain("Settings");
    expect(result.data).toMatchObject({
      error: "SETTINGS_HOST_MANAGED",
      suppressPostActionContinuation: true,
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(configMocks.save).not.toHaveBeenCalled();
    expect(runtime.setSetting).not.toHaveBeenCalled();
  });

  it("still shows backends and sets the owner name", async () => {
    const runtime = fakeRuntime();
    const shown = await runSettings(runtime, { action: "show_backends" });
    expect(shown.success).toBe(true);
    const named = await runSettings(runtime, {
      action: "set_owner_name",
      name: "Sam",
    });
    expect(named.success).toBe(true);
    expect(named.text).toBe('Owner name set to "Sam".');
  });
});

describe("SETTINGS without a host policy", () => {
  beforeEach(() => {
    configMocks.load.mockImplementation(() => ({}));
    configMocks.save.mockReset();
    vi.stubEnv("ELIZA_HOST_OPERATION_POLICY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never echoes the api key, even in a failure message", async () => {
    const runtime = fakeRuntime();
    const saved = await runSettings(runtime, {
      action: "update_ai_provider",
      provider: "openai",
      apiKey: API_KEY,
    });
    expect(saved.success).toBe(true);
    expect(configMocks.save).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(saved)).not.toContain(API_KEY);

    configMocks.save.mockImplementation(() => {
      throw new Error(`rejected key ${API_KEY}`);
    });
    const failed = await runSettings(runtime, {
      action: "update_ai_provider",
      provider: "openai",
      apiKey: ` ${API_KEY} `,
    });
    expect(failed.success).toBe(false);
    expect(failed.text).toContain("[redacted]");
    expect(JSON.stringify(failed)).not.toContain(API_KEY);
  });

  it("says toggle_capability changes only the settings-page preference", async () => {
    const result = await runSettings(fakeRuntime(), {
      action: "toggle_capability",
      capability: "browser",
      enabled: true,
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "Changed the settings-page preference for browser to on. This does not add or remove agent actions.",
    );
    expect(configMocks.save).toHaveBeenCalledWith({
      ui: { capabilities: { browser: true } },
    });
  });
});

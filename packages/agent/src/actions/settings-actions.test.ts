import { validateToolArgs } from "@elizaos/core";
import { normalizeFirstRunProviderId } from "@elizaos/host/protocol";
import { describe, expect, it } from "vitest";
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

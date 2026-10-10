import { validateToolArgs } from "@elizaos/core";
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

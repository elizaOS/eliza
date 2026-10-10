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
});

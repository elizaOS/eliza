/**
 * Exercises legacy typed web-search configuration through the real parser,
 * preserving accepted values while rejecting invalid provider configuration.
 */
import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "./types";
import { ToolsWebSearchSchema } from "./zod-schema.agent-runtime";

describe("legacy web search configuration", () => {
  it.each(["brave", "perplexity"] as const)(
    "preserves complete existing %s configuration",
    (provider) => {
      const config: ElizaConfig = {
        tools: {
          web: {
            search: {
              enabled: false,
              provider,
              apiKey: "legacy-brave-key",
              perplexity: {
                apiKey: "legacy-perplexity-key",
                baseUrl: "https://legacy.example.invalid",
                model: "legacy-model",
              },
              maxResults: 8,
              timeoutSeconds: 30,
              cacheTtlMinutes: 0,
            },
          },
        },
      };
      const search = config.tools?.web?.search;
      expect(ToolsWebSearchSchema.parse(search)).toEqual(search);
    },
  );

  it("does not turn retired fields into an unchecked configuration bag", () => {
    expect(
      ToolsWebSearchSchema.safeParse({ provider: "unsupported" }).success,
    ).toBe(false);
    expect(
      ToolsWebSearchSchema.safeParse({ perplexity: { apiKey: 42 } }).success,
    ).toBe(false);
  });
});

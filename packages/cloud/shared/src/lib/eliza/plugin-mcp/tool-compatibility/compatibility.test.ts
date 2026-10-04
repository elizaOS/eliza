import { expect, test } from "bun:test";
import { AnthropicMcpCompatibility } from "./providers/anthropic";
import { GoogleMcpCompatibility } from "./providers/google";
import { OpenAIMcpCompatibility } from "./providers/openai";

test("Google preserves unrendered constraints and the original model-facing description", () => {
  const policy = new GoogleMcpCompatibility({ provider: "google", modelId: "gemini" });
  const input = {
    type: "string" as const,
    description: "Complete source",
    format: "custom-format",
    minLength: 3,
  };
  const result = policy.transformToolSchema(input);
  expect(result.description).toBe(
    'Complete source\n\nConstraints: at least 3 chars {"format":"custom-format"}',
  );
  expect(result).not.toHaveProperty("format");
  expect(input.format).toBe("custom-format");
});

test("Anthropic keeps schema-valued additionalProperties in the description", () => {
  const policy = new AnthropicMcpCompatibility({ provider: "anthropic", modelId: "claude" });
  const result = policy.transformToolSchema({
    type: "object",
    additionalProperties: { type: "string" },
    description: "Source",
  });
  expect(result.description).toBe('Source. {"additionalProperties":{"type":"string"}}');
  expect(result).not.toHaveProperty("additionalProperties");
});

test("cloud OpenAI policy keeps davinci patterns and bypasses supported structured output", () => {
  const policy = new OpenAIMcpCompatibility({ provider: "openai", modelId: "davinci" });
  expect(policy.transformToolSchema({ type: "string", pattern: "^a", format: "email" })).toEqual({
    type: "string",
    pattern: "^a",
    description: '{"pattern":"^a","format":"email"}',
  });
  const supported = new OpenAIMcpCompatibility({
    provider: "openai",
    modelId: "gpt",
    supportsStructuredOutputs: true,
  });
  const input = { type: "string" as const, format: "email" };
  expect(supported.transformToolSchema(input)).toEqual(input);
});

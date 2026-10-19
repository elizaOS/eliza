/**
 * Exercises the OpenAI tool-schema fixup on models without structured outputs:
 * the description may only restate the constraint keywords the fixup removes.
 */
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import {
  OpenAIMcpCompatibility,
  OpenAIReasoningMcpCompatibility,
} from "../src/tool-compatibility/providers/openai";

function compatibility(modelId: string): OpenAIMcpCompatibility {
  return new OpenAIMcpCompatibility({
    provider: "openai",
    modelId,
    supportsStructuredOutputs: false,
  });
}

type Schema = {
  type: string;
  properties: Record<string, Record<string, unknown> & { description?: string }>;
};

type Policy = OpenAIMcpCompatibility | OpenAIReasoningMcpCompatibility;

function transform(modelId: string, schema: Schema, policy?: Policy): Schema {
  const selected = policy ?? compatibility(modelId);
  return selected.transformToolSchema(schema as unknown as JSONSchema7) as unknown as Schema;
}

describe("OpenAI MCP tool-schema descriptions", () => {
  it("does not restate a keyword that stays in the schema", () => {
    const output = transform("gpt-4o-mini", {
      type: "object",
      properties: {
        name: { type: "string", minLength: 2, maxLength: 40, description: "Your full name." },
        color: { type: "string", enum: ["red", "blue"], description: "Pick a color." },
        count: { type: "integer", minimum: 1, maximum: 9, description: "How many." },
        port: { type: "integer", format: "int32", minimum: 1, description: "Port." },
        ratio: { type: "number", format: "double", description: "Ratio." },
        stamp: { format: "date-time", description: "Stamp." },
        tags: { type: "array", items: { type: "string" }, minItems: 1, description: "Labels." },
      },
    });
    const properties = output.properties;

    // Every keyword above is enforced by the schema this model receives.
    expect(properties.name.minLength).toBe(2);
    expect(properties.name.maxLength).toBe(40);
    expect(properties.color.enum).toEqual(["red", "blue"]);
    expect(properties.count.minimum).toBe(1);
    expect(properties.tags.minItems).toBe(1);
    // This model rejects `format` on strings only.
    expect(properties.port.format).toBe("int32");
    expect(properties.ratio.format).toBe("double");
    expect(properties.stamp.format).toBe("date-time");

    // The model must not read the same rule twice in different notations.
    expect(properties.name.description).toBe("Your full name.");
    expect(properties.color.description).toBe("Pick a color.");
    expect(properties.count.description).toBe("How many.");
    expect(properties.tags.description).toBe("Labels.");
    expect(properties.port.description).toBe("Port.");
    expect(properties.ratio.description).toBe("Ratio.");
    expect(properties.stamp.description).toBe("Stamp.");
  });

  it("does not repeat a kept enum in the note for a reasoning model", () => {
    const policy = new OpenAIReasoningMcpCompatibility({
      provider: "openai",
      modelId: "gpt-5",
      supportsStructuredOutputs: false,
      isReasoningModel: true,
    });
    const output = transform(
      "gpt-5",
      {
        type: "object",
        properties: {
          level: { type: "string", minLength: 2, enum: ["low", "high"], description: "Level." },
        },
      },
      policy
    );
    const level = output.properties.level;

    expect(level).not.toHaveProperty("minLength");
    expect(level.enum).toEqual(["low", "high"]);
    expect(level.description).toBe("Level.\n\nIMPORTANT: minimum 2 characters");
  });

  it("still restates the format keyword that the schema loses", () => {
    const output = transform("gpt-4o-mini", {
      type: "object",
      properties: {
        when: { type: "string", format: "date-time", description: "Meeting start." },
      },
    });
    expect(output.properties.when.format).toBeUndefined();
    expect(output.properties.when.description).toBe('Meeting start.\n{"format":"date-time"}');
  });

  it("restates pattern only for the models that reject it", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        code: { type: "string", pattern: "^[a-z]+$", minLength: 2, description: "Lowercase code." },
      },
    };

    const legacy = transform("gpt-3.5-turbo", schema);
    expect(legacy.properties.code.pattern).toBeUndefined();
    expect(legacy.properties.code.description).toBe('Lowercase code.\n{"pattern":"^[a-z]+$"}');
    // minLength is kept by this model, so it stays only in the schema.
    expect(legacy.properties.code.minLength).toBe(2);

    const current = transform("gpt-4o", schema);
    expect(current.properties.code.pattern).toBe("^[a-z]+$");
    expect(current.properties.code.description).toBe("Lowercase code.");
  });

  it("does not copy a long enum into the description", () => {
    const values = Array.from({ length: 40 }, (_, index) => `choice_${index}`);
    const output = transform("gpt-4o-mini", {
      type: "object",
      properties: {
        mode: { type: "string", enum: values, description: "Choose a mode." },
      },
    });
    expect(output.properties.mode.enum).toEqual(values);
    expect(output.properties.mode.description).toBe("Choose a mode.");
    expect(output.properties.mode.description).not.toContain("choice_0");
  });

  it("leaves the description of an unconstrained property untouched", () => {
    const output = transform("gpt-4o-mini", {
      type: "object",
      properties: { query: { type: "string", description: "What to search." } },
    });
    expect(output.properties.query.description).toBe("What to search.");
  });
});

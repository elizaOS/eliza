import { describe, expect, it } from "vitest";

import { toOpenAITool, toOpenAITools } from "../tool-format/openai.js";
import type { NativeTool } from "../tool-schema.js";

const sampleTool: NativeTool = {
  type: "custom",
  name: "bash",
  description: "Run a bash command.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "command to run" },
      timeout_ms: { type: "number", description: "timeout in ms" },
    },
    required: ["command"],
  },
};

describe("toOpenAITool", () => {
  it("converts a single NativeTool to OpenAI function-tool shape", () => {
    const out = toOpenAITool(sampleTool);
    expect(out).toEqual({
      type: "function",
      name: "bash",
      description: "Run a bash command.",
      parameters: sampleTool.input_schema,
      strict: false,
    });
  });

  it("defaults strict to false (relaxed parsing)", () => {
    const out = toOpenAITool(sampleTool);
    expect(out.strict).toBe(false);
  });

  it("preserves the input_schema reference verbatim as parameters", () => {
    const out = toOpenAITool(sampleTool);
    // Same JSON Schema object passed through (we don't deep-clone).
    expect(out.parameters).toBe(sampleTool.input_schema);
  });

  it("does not mutate the source tool", () => {
    const before = JSON.stringify(sampleTool);
    toOpenAITool(sampleTool);
    expect(JSON.stringify(sampleTool)).toBe(before);
  });
});

describe("toOpenAITools", () => {
  it("converts an array of tools cleanly", () => {
    const second: NativeTool = {
      type: "custom",
      name: "ignore",
      description: "Skip this message silently.",
      input_schema: { type: "object", properties: {} },
    };
    const out = toOpenAITools([sampleTool, second]);
    expect(out).toHaveLength(2);
    expect(out[0]?.name).toBe("bash");
    expect(out[0]?.type).toBe("function");
    expect(out[1]?.name).toBe("ignore");
    expect(out[1]?.type).toBe("function");
    expect(out.every((t) => t.strict === false)).toBe(true);
  });

  it("returns an empty array for empty input", () => {
    expect(toOpenAITools([])).toEqual([]);
  });

  it("converts the default registry without errors", async () => {
    const { buildDefaultRegistry } = await import("../tools/registry.js");
    const { buildToolsArray } = await import("../tool-schema.js");
    const reg = buildDefaultRegistry();
    const native = buildToolsArray(reg);
    expect(native.length).toBeGreaterThan(0);

    const openai = toOpenAITools(native);
    expect(openai).toHaveLength(native.length);

    for (const t of openai) {
      expect(t.type).toBe("function");
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.parameters).toBeDefined();
      expect((t.parameters as { type?: string }).type).toBe("object");
      expect(t.strict).toBe(false);
    }

    // The default registry is safe-by-default: bash is shipped as a tool but
    // not exposed unless a caller opts into registering it.
    const names = openai.map((t) => t.name);
    expect(names).not.toContain("bash");
    expect(names).toContain("ignore");
  });
});

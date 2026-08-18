/**
 * Regression coverage for provider-specific MCP schema transformations using
 * deterministic JSON Schema inputs and no external MCP server.
 */
import { describe, expect, it } from "vitest";
import { GoogleMcpCompatibility } from "../src/tool-compatibility/providers/google.ts";

describe("MCP tool compatibility", () => {
  it("preserves zero upper bounds in Google descriptions", () => {
    const compatibility = new GoogleMcpCompatibility({
      provider: "google",
      modelId: "gemini-pro",
    });

    // minLength/minItems are set alongside the zero upper bound so a
    // fallback path that only fires when every constraint is skipped
    // can't mask a truthy-check regression on maxLength/maxItems.
    const transformed = compatibility.transformToolSchema({
      type: "object",
      properties: {
        boundedText: { type: "string", minLength: 1, maxLength: 0 },
        boundedList: {
          type: "array",
          minItems: 1,
          maxItems: 0,
          items: { type: "string" },
        },
      },
    });

    expect(transformed.properties?.boundedText).toMatchObject({
      type: "string",
      description: expect.stringContaining("0"),
    });
    expect(transformed.properties?.boundedList).toMatchObject({
      type: "array",
      description: expect.stringContaining("0"),
    });
  });
});

/**
 * Pure-helper tests for v1/chat/completions/route.ts's tool_choice + tools
 * mappers. These exercise the AI-SDK shape conversion that runs before
 * generateText/streamText, and prevent regressions of the
 * `mapToolChoice("required")` crash — `"required"` is a valid OpenAI-API
 * value (and the elizaOS planner sends it for forced-tool turns), but the
 * pre-fix code only early-returned on "auto" / "none" and fell through to
 * `toolChoice.function.name`, which is undefined on a string and produced
 * a 500 with body `{"error":{"message":"Cannot read properties of
 * undefined (reading 'name')"...}}`.
 *
 * Route-level happy-path / auth scenarios live in test/e2e — these are
 * pure and run without I/O.
 */

import { describe, expect, test } from "bun:test";

import { __nativeToolingTestHooks } from "../v1/chat/completions/route";

const { mapToolChoice, convertTools } = __nativeToolingTestHooks;

describe("mapToolChoice", () => {
  test("returns undefined when toolChoice is undefined", () => {
    expect(mapToolChoice(undefined)).toBeUndefined();
  });

  test('returns "auto" unchanged', () => {
    expect(mapToolChoice("auto")).toBe("auto");
  });

  test('returns "none" unchanged', () => {
    expect(mapToolChoice("none")).toBe("none");
  });

  test('returns "required" unchanged (regression: pre-fix crashed with "Cannot read properties of undefined (reading \'name\')")', () => {
    // This is the regression. The OpenAI API and the AI SDK both accept
    // tool_choice: "required" to force the model to call some tool. The
    // elizaOS planner sends it for forced-tool turns (services/message.ts).
    // Before the fix, this fell through to `toolChoice.function.name` and
    // crashed because `"required".function` is undefined.
    expect(mapToolChoice("required")).toBe("required");
  });

  test("maps explicit function selection to AI-SDK { type: tool, toolName } shape", () => {
    expect(
      mapToolChoice({ type: "function", function: { name: "search_web" } }),
    ).toEqual({ type: "tool", toolName: "search_web" });
  });
});

describe("convertTools", () => {
  test("returns undefined when tools is undefined", () => {
    expect(convertTools(undefined)).toBeUndefined();
  });

  test("returns undefined when tools is an empty array", () => {
    expect(convertTools([])).toBeUndefined();
  });

  test("maps a single OpenAI-shaped tool to an AI-SDK tool record keyed by name", () => {
    const out = convertTools([
      {
        type: "function",
        function: {
          name: "search_web",
          description: "Search the web for a query.",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      },
    ]);

    expect(out).toBeDefined();
    const tool = out?.search_web;
    expect(tool).toBeDefined();
    expect(tool?.description).toBe("Search the web for a query.");
    // inputSchema / outputSchema are AI-SDK JSONSchema wrappers; we just
    // assert their presence rather than walk their internal shape.
    expect(tool?.inputSchema).toBeDefined();
    expect(tool?.outputSchema).toBeDefined();
  });

  test("omits description when tool has none", () => {
    const out = convertTools([
      { type: "function", function: { name: "noop" } },
    ]);
    expect(out?.noop).toBeDefined();
    expect(out?.noop).not.toHaveProperty("description");
  });
});

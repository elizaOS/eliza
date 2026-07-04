// Exercises vercel ai gateway tools behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { normalizeToolFunction, toGatewayTools } from "./vercel-ai-gateway";

/**
 * Regression: the gateway's toGatewayTools read `tool.function.name`
 * unconditionally. elizaOS core's createHandleResponseTool() / action planner
 * send a FLAT ToolDefinition (`{ name, type, parameters }`) with no nested
 * `function`, so this threw "Cannot read properties of undefined (reading
 * 'name')" — an opaque 500 on the should-respond (RESPONSE_HANDLER) turn of
 * every dedicated cloud agent.
 */
describe("toGatewayTools — tolerates flat ToolDefinition shape", () => {
  const flatHandleResponse = {
    name: "HANDLE_RESPONSE",
    description: "Decide whether and how to respond",
    type: "function",
    strict: true,
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  };

  // Cast unknown tool shapes to the gateway's tool param type without `any` —
  // the whole point of these tests is that the runtime shape diverges from the
  // declared type.
  const gatewayTools = (...tools: unknown[]) => toGatewayTools(tools as never);

  test("does not throw on the exact flat shape that 500'd in prod", () => {
    expect(() => gatewayTools(flatHandleResponse)).not.toThrow();
  });

  test("keys the gateway tool map by the flat tool name", () => {
    const result = gatewayTools(flatHandleResponse);
    expect(Object.keys(result)).toEqual(["HANDLE_RESPONSE"]);
  });

  test("still handles the nested OpenAI shape", () => {
    const nested = {
      type: "function",
      function: { name: "GET_WEATHER", parameters: { type: "object" } },
    };
    const result = gatewayTools(nested);
    expect(Object.keys(result)).toEqual(["GET_WEATHER"]);
  });

  test("drops nameless tools instead of throwing", () => {
    const nameless = { type: "function", parameters: { type: "object" } };
    const result = gatewayTools(nameless, flatHandleResponse);
    expect(Object.keys(result)).toEqual(["HANDLE_RESPONSE"]);
  });
});

describe("normalizeToolFunction", () => {
  test("reads name/parameters from the flat shape", () => {
    const out = normalizeToolFunction({
      name: "A",
      type: "function",
      parameters: { type: "object" },
    });
    expect(out.name).toBe("A");
    expect(out.parameters).toMatchObject({ type: "object" });
  });

  test("reads name/parameters from the nested shape", () => {
    const out = normalizeToolFunction({
      type: "function",
      function: { name: "B", parameters: { type: "object", title: "nested" } },
    });
    expect(out.name).toBe("B");
    expect(out.parameters).toMatchObject({ title: "nested" });
  });

  test("returns undefined name for a nameless / non-object input", () => {
    expect(normalizeToolFunction({}).name).toBeUndefined();
    expect(normalizeToolFunction(undefined).name).toBeUndefined();
  });
});

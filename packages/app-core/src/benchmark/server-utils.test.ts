import { describe, expect, it } from "vitest";
import { coerceParams } from "./server-utils";

describe("coerceParams", () => {
  it("returns object params as-is", () => {
    expect(
      coerceParams({ BENCHMARK_ACTION: { command: "search[laptop]" } }),
    ).toEqual({
      BENCHMARK_ACTION: { command: "search[laptop]" },
    });
  });

  it("parses JSON object strings", () => {
    expect(
      coerceParams(
        '{"BENCHMARK_ACTION":{"tool_name":"lookup","arguments":{}}}',
      ),
    ).toEqual({
      BENCHMARK_ACTION: { tool_name: "lookup", arguments: {} },
    });
  });

  it("does not parse non-JSON key-value text", () => {
    expect(
      coerceParams("BENCHMARK_ACTION:\n  command: search[laptop]"),
    ).toEqual({});
  });
});

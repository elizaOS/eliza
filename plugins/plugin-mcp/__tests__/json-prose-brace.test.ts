/** Exercises the model-reply JSON reader on replies whose prose contains braces:
 * the tool arguments follow the prose, so they must be the object that is read. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { parseJSON } from "../src/protocol-utils/json";
import { withModelRetry } from "../src/utils/wrapper";

describe("parseJSON with braces in the prose", () => {
  it("reads an arguments object with no prose", () => {
    expect(parseJSON('{"query":"weather","units":"metric"}')).toEqual({
      query: "weather",
      units: "metric",
    });
  });

  it("reads the call after brace words in a sentence", () => {
    expect(
      parseJSON('Set units with {metric} or {imperial}. Call: {"query":"weather","units":"metric"}')
    ).toEqual({ query: "weather", units: "metric" });
  });

  it("reads the call after an empty object named in the prose", () => {
    expect(
      parseJSON('If there is nothing to pass, use {}. Call: {"query":"weather","units":"metric"}')
    ).toEqual({ query: "weather", units: "metric" });
  });

  it("reads the call, not the example object, in the prose", () => {
    expect(
      parseJSON(
        'For example {units: "imperial"} works too. Call: {"query":"weather","units":"metric"}'
      )
    ).toEqual({ query: "weather", units: "metric" });
  });

  it("reads the outer call when an example object has the same shape", () => {
    expect(
      parseJSON(
        'Example: {"toolArguments":{"query":"London"}}. Use this call: {"toolArguments":{"query":"Bangkok"}}'
      )
    ).toEqual({ toolArguments: { query: "Bangkok" } });
  });

  it("reads the call after an apostrophe in the prose", () => {
    expect(parseJSON('Don\'t pass {units}. Call: {"query":"weather"}')).toEqual({
      query: "weather",
    });
  });

  it("reads the call, not the example, when the prose and the call hold apostrophes", () => {
    expect(parseJSON('Example: {"city":"London"}. Here\'s the call: {"city":"Xi\'an"}')).toEqual({
      city: "Xi'an",
    });
  });

  it("keeps escaped quotes and comments inside the call", () => {
    expect(
      parseJSON('Use {x} now: {"query":"say \\"hi\\"" /* a { b */ ,"units":"metric"}')
    ).toEqual({
      query: 'say "hi"',
      units: "metric",
    });
  });
});

describe("withModelRetry on a reply with braces in the prose", () => {
  it("keeps the call instead of a schema-valid example from the prose", async () => {
    const replies = [
      'Example: {"toolArguments":{"query":"London"}}. Use this call: {"toolArguments":{"query":"Bangkok"}}',
      '{"toolArguments":{"query":"RETRY"}}',
    ];
    let modelCalls = 0;
    const runtime = {
      getSetting: () => ({ maxRetries: 2 }),
      useModel: async () => {
        modelCalls += 1;
        return replies[Math.min(modelCalls, replies.length - 1)];
      },
    } as unknown as IAgentRuntime;
    const validationFn = (value: unknown) => {
      const args = (value as { toolArguments?: Record<string, unknown> }).toolArguments;
      return typeof args?.query === "string"
        ? { success: true as const, data: value as Record<string, unknown> }
        : { success: false as const, error: "toolArguments.query must be a string" };
    };

    const result = await withModelRetry<Record<string, unknown>>({
      runtime,
      message: { content: { text: "weather in London" } } as never,
      state: {} as never,
      input: replies[0],
      validationFn,
      createFeedbackPromptFn: () => "Send the call again.",
    });

    expect(result).toEqual({ toolArguments: { query: "Bangkok" } });
    expect(modelCalls).toBe(0);
  });
});

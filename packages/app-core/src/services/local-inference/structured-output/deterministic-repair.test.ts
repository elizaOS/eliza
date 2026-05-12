import type { JSONSchema, ResponseSkeleton } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  repairStructuredOutput,
  StructuredOutputRepairStream,
} from "./deterministic-repair";

const actionSkeleton: ResponseSkeleton = {
  spans: [
    { kind: "literal", value: '{"action":' },
    { kind: "enum", key: "action", enumValues: ["BLOCK", "BRIEF"] },
    { kind: "literal", value: ',"parameters":' },
    { kind: "free-json", key: "parameters" },
    { kind: "literal", value: ',"thought":' },
    { kind: "free-string", key: "thought" },
    { kind: "literal", value: "}" },
  ],
};

describe("deterministic structured-output repair", () => {
  it("completes an unambiguous enum and advances to the next JSON field", () => {
    expect(
      repairStructuredOutput('{"action":"BLO', {
        skeleton: actionSkeleton,
      }),
    ).toEqual({
      text: '{"action":"BLOCK","parameters":',
      status: "repaired",
      reason: "free-span-incomplete",
    });
  });

  it("fails safely when an enum prefix is ambiguous", () => {
    const repaired = repairStructuredOutput('{"action":"B', {
      skeleton: actionSkeleton,
    });
    expect(repaired.text).toBe('{"action":"B');
    expect(repaired.status).toBe("ambiguous");
  });

  it("fails safely when an enum value is hallucinated", () => {
    const repaired = repairStructuredOutput('{"action":"DELETE"', {
      skeleton: actionSkeleton,
    });
    expect(repaired.text).toBe('{"action":"DELETE"');
    expect(repaired.status).toBe("invalid");
  });

  it("repairs a missing required-parameter comma and closes the object", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        url: { type: "string" },
        selector: { type: "string" },
      },
      required: ["url", "selector"],
    };
    expect(
      repairStructuredOutput('{"url":"https://example.test" "selector":"#go"', {
        jsonSchema: schema,
      }),
    ).toEqual({
      text: '{"url":"https://example.test","selector":"#go"}',
      status: "repaired",
    });
  });

  it("repairs a semicolon separator when the following key is schema-known", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        url: { type: "string" },
        selector: { type: "string" },
      },
      required: ["url", "selector"],
    };
    expect(
      repairStructuredOutput('{"url":"https://example.test";"selector":"#go"', {
        jsonSchema: schema,
      }).text,
    ).toBe('{"url":"https://example.test","selector":"#go"}');
  });

  it("fills a required deterministic enum parameter", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        op: { type: "string", enum: ["open"] },
      },
      required: ["op"],
    };
    expect(repairStructuredOutput("{", { jsonSchema: schema })).toEqual({
      text: '{"op":"open"}',
      status: "repaired",
    });
  });

  it("does not invent an ambiguous required parameter value", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    };
    expect(repairStructuredOutput("{", { jsonSchema: schema })).toEqual({
      text: "{",
      status: "unchanged",
      reason: "missing-required-value-ambiguous",
    });
  });

  it("deduplicates deterministic scaffold if the stream later emits it", () => {
    const stream = new StructuredOutputRepairStream({
      skeleton: actionSkeleton,
    });
    expect(stream.push('{"action":"BLO')).toBe(
      '{"action":"BLOCK","parameters":',
    );
    expect(stream.push('CK","parameters":{}')).toBe('{},"thought":');
    expect(stream.flush()).toBe("");
  });
});

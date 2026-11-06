import type { StructuredStreamGate } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

/** The value each routing field takes on a direct answer. */
const DIRECT_ANSWER_VALUES: Record<string, unknown> = {
  shouldRespond: "RESPOND",
  contexts: ["simple"],
  intents: [],
  contextRequests: [],
  candidateActionNames: [],
  completionContext: null,
  requiresTool: false,
  replyEffectStatus: "none",
};

async function stage1StreamCall() {
  const runtime = makeRuntime([
    stage1Response({
      thought: "Direct answer.",
      contexts: ["simple"],
      replyText: "Octopuses have three hearts.",
    }),
  ]);
  await runStage1({
    runtime,
    message: makeMessage({ text: "tell me an octopus fact" }),
  });
  const params = useModelCalls(runtime)[0]?.[1] as {
    streamFieldGate?: StructuredStreamGate;
    responseSkeleton?: { spans: Array<{ key?: string }> };
  };
  const keys = (params.responseSkeleton?.spans ?? [])
    .map((span) => span.key)
    .filter((key): key is string => typeof key === "string");
  const precedingKeys = [...new Set(keys.slice(0, keys.indexOf("replyText")))];
  return { gate: params.streamFieldGate, keys, precedingKeys };
}

describe("Stage 1 reply stream gate", () => {
  it("opens for a direct answer with the fields the real Stage-1 schema writes before replyText", async () => {
    const { gate, keys, precedingKeys } = await stage1StreamCall();
    expect(gate).toBeTypeOf("function");
    expect(keys).toContain("replyText");
    // Stage 1 leaves candidateActionNames out of its schema; the gate must
    // not wait for a field the model never writes.
    expect(keys).not.toContain("candidateActionNames");
    const preceding = Object.fromEntries(
      precedingKeys.map((key) => [key, DIRECT_ANSWER_VALUES[key]]),
    );
    expect(precedingKeys.every((key) => key in DIRECT_ANSWER_VALUES)).toBe(
      true,
    );
    expect(gate?.(preceding)).toBe(true);
  });

  it("holds when the routing fields send the turn to planned work or are incomplete", async () => {
    const { gate, precedingKeys } = await stage1StreamCall();
    const direct = Object.fromEntries(
      precedingKeys.map((key) => [key, DIRECT_ANSWER_VALUES[key]]),
    );
    expect(gate?.({ ...direct, contexts: ["calendar"] })).toBe(false);
    expect(gate?.({ ...direct, intents: ["schedule a meeting"] })).toBe(false);
    expect(gate?.({ ...direct, candidateActionNames: ["SEND_EMAIL"] })).toBe(
      false,
    );
    const { contexts: _omitted, ...withoutContexts } = direct;
    expect(gate?.(withoutContexts)).toBe(false);
    if (precedingKeys.includes("replyEffectStatus")) {
      const { replyEffectStatus: _status, ...withoutStatus } = direct;
      expect(gate?.(withoutStatus)).toBe(false);
    }
    expect(gate?.(undefined)).toBe(false);
  });
});

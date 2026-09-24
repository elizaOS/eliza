/** Ensures live harness outputs are decoded without benchmark-answer repair. */

import { describe, expect, it } from "vitest";
import {
  decodeHarnessStage1,
  decodeHarnessStage1Text,
} from "../src/llm-harness.ts";

function nativeResult(overrides: Record<string, unknown> = {}) {
  return {
    shouldRespond: "IGNORE",
    contexts: [],
    intents: [],
    candidateActionNames: [],
    replyText: "",
    facts: [],
    relationships: [],
    addressedTo: [],
    threadOps: [],
    ...overrides,
  };
}

describe("live harness output fairness", () => {
  it("does not fabricate a known factual answer for an empty native result", () => {
    const native = nativeResult();

    expect(decodeHarnessStage1(native)).toEqual(native);
    expect(decodeHarnessStage1(native).replyText).not.toContain("Paris");
  });

  it("does not turn a native stop operation into a benchmark-preferred abort", () => {
    const stop = {
      type: "stop",
      workThreadId: "thread-1",
      sourceWorkThreadIds: [],
      sourceRef: null,
      instruction: null,
      reason: "user cancelled",
    };
    const native = nativeResult({
      shouldRespond: "RESPOND",
      threadOps: [stop],
    });

    const decoded = decodeHarnessStage1(native);

    expect(decoded).toEqual(native);
    expect(decoded.replyText).toBe("");
    expect(decoded.threadOps).toEqual([stop]);
  });

  it("preserves incomplete semantics instead of synthesizing thread operations", () => {
    const native = nativeResult({
      shouldRespond: "RESPOND",
      replyText: "I understand the request.",
    });

    const decoded = decodeHarnessStage1(native);

    expect(decoded).toEqual(native);
    expect(decoded.threadOps).toEqual([]);
  });

  it("rejects plain text instead of converting it into a response", () => {
    expect(() => decodeHarnessStage1Text("Paris.")).toThrow(
      "harness response did not contain JSON",
    );
  });

  it("rejects missing or malformed required Stage-1 fields", () => {
    expect(() =>
      decodeHarnessStage1(nativeResult({ shouldRespond: "STOP" })),
    ).toThrow("shouldRespond must be RESPOND or IGNORE");
    expect(() =>
      decodeHarnessStage1(nativeResult({ contexts: ["valid", 42] })),
    ).toThrow("contexts must be an array of strings");
    expect(() =>
      decodeHarnessStage1(nativeResult({ relationships: [{}] })),
    ).toThrow("must contain string subject, predicate, and object");
    expect(() =>
      decodeHarnessStage1(
        nativeResult({
          threadOps: [
            {
              type: "abort",
              workThreadId: "thread-1",
              sourceWorkThreadIds: "thread-1",
              sourceRef: null,
              instruction: null,
              reason: "cancelled",
            },
          ],
        }),
      ),
    ).toThrow("sourceWorkThreadIds must be an array of strings");
  });
});

/** Real runtime dispatcher and recovery boundary with a controlled failed model.
 * No provider traffic; optional presentation and required recovery stay distinct. */
import {
  ElizaError,
  type Memory,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, test } from "vitest";
import { rewriteActionCallbackInCharacter } from "./delivery";
import { resolvePlannedReplyEgress } from "./egress-policy";

function fixture() {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Recovery", bio: "test", settings: {} },
    logLevel: "fatal",
  });
  const failure = new ElizaError("Controlled unauthorized provider", {
    code: "CONTROLLED_PROVIDER_UNAUTHORIZED",
    context: { statusCode: 401 },
  });
  let calls = 0;
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async () => {
      calls += 1;
      throw failure;
    },
    "openai",
  );
  const message: Memory = {
    id: stringToUuid("recovery-cause-turn"),
    roomId: stringToUuid("recovery-cause-room"),
    entityId: stringToUuid("recovery-cause-user"),
    agentId: runtime.agentId,
    content: { text: "Tell me what was actually observed." },
  };
  return { runtime, failure, message, calls: () => calls };
}

function retainsCause(error: unknown, expected: Error): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current === expected) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

test("required reply recovery retains the actual model failure without an action replay or rejected-draft success", async () => {
  const f = fixture();
  try {
    let outcome: unknown;
    try {
      await resolvePlannedReplyEgress({
        runtime: f.runtime,
        message: f.message,
        reply: "",
        actionResults: [],
      });
    } catch (error) {
      // error-policy:J1 assertion boundary retains the actual failure.
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(ElizaError);
    expect(outcome).toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
    expect(retainsCause(outcome, f.failure)).toBe(true);
    expect(f.calls()).toBeGreaterThan(0);
  } finally {
    await f.runtime.stop();
    await f.runtime.close();
  }
});

test("optional action voice still degrades to its already user-destined callback after model failure", async () => {
  const f = fixture();
  try {
    expect(
      await rewriteActionCallbackInCharacter({
        runtime: f.runtime,
        message: f.message,
        response: { text: "Observed result" },
        text: "Observed result",
      }),
    ).toBeNull();
    expect(f.calls()).toBeGreaterThan(0);
  } finally {
    await f.runtime.stop();
    await f.runtime.close();
  }
});

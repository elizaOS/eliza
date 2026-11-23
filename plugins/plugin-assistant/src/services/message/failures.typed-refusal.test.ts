/**
 * The Cloud types a provider 429 as an exhausted retry budget, so the runtime
 * does not upload the same refused request again for every model slot. The
 * failure reply must still report it as a refusal, with its wait, or as a
 * spent balance: not as Cloud warming, which ends with an empty reply.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { makeRuntime } from "../../__tests__/stage1/fixtures.ts";
import { MessageFailures } from "./failures.ts";

const RETRY_BUDGET = "MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED";

function typedRefusal(extra: Record<string, unknown> = {}): Error {
  return Object.assign(
    new ElizaError("Too Many Requests", {
      code: RETRY_BUDGET,
      context: { provider: "elizaOSCloud", status: 429 },
      severity: "ephemeral",
    }),
    { status: 429, ...extra },
  );
}

function refusingRuntime(error: Error): IAgentRuntime {
  const runtime = makeRuntime([]);
  (runtime as { useModel: unknown }).useModel = vi.fn(async () => {
    throw error;
  });
  return runtime;
}

const reply = (error: Error) =>
  new MessageFailures().generateFailureReplyText(
    refusingRuntime(error),
    "Apologise briefly.",
    "running the native tool message runtime",
  );

describe("a failure reply whose own model call is refused with a typed 429", () => {
  it("reports the refusal, not Cloud warming", async () => {
    expect(await reply(typedRefusal())).toEqual({ kind: "rateLimited" });
  });

  it("keeps the wait the refusal carries", async () => {
    const rateLimit = {
      kind: "rate_limited",
      retryAfterMs: 1500,
      scope: "burst",
    };
    expect(await reply(typedRefusal({ rateLimit }))).toMatchObject({
      kind: "rateLimited",
      rateLimit: { retryAfterMs: 1500 },
    });
  });

  it("still ends on warming for a typed exhaustion that is not a refusal", async () => {
    const warming = new ElizaError("Cloud is warming", {
      code: RETRY_BUDGET,
      context: { provider: "elizaOSCloud", status: 503 },
      severity: "ephemeral",
    });
    Object.assign(warming, { status: 503 });
    expect(await reply(warming)).toEqual({ kind: "text", value: "" });
  });
});

/**
 * Regression tests: the parent-agent reply delivery must read the
 * `sendToSession` prompt receipt. `sendPrompt` resolves with a
 * `PromptResult` for cancelled/stopped/errored turns instead of throwing,
 * so a resolve alone is not proof the reply's turn ran — the same
 * classification `undeliveredReason` applies to follow-up prompts in
 * api/agent-routes.ts. Before the fix, `deliverReplyToChild` discarded the
 * receipt and reported `delivered: true` for every resolved receipt.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { dispatchParentAgentDirective } from "../services/parent-agent-dispatch.js";
import type { PromptResult } from "../services/types.js";

function makeRuntime(): IAgentRuntime {
  return {
    actions: [],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function makeReceipt(overrides: Partial<PromptResult>): PromptResult {
  return {
    sessionId: "child-session",
    response: "",
    finalText: "",
    stopReason: "end_turn",
    durationMs: 1,
    ...overrides,
  };
}

async function dispatchWithReceipt(receipt: PromptResult) {
  const sendToSession = vi.fn(async () => receipt);
  const emitSessionEvent = vi.fn();
  const result = await dispatchParentAgentDirective({
    runtime: makeRuntime(),
    acp: { sendToSession, emitSessionEvent } as never,
    sessionId: "child-session",
    args: { mode: "list-actions" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return result;
}

describe("parent-agent reply delivery receipt", () => {
  it("reports delivered when the reply turn settles end_turn", async () => {
    const result = await dispatchWithReceipt(makeReceipt({}));
    expect(result.brokerSuccess).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("reports not delivered when the reply turn settles error", async () => {
    const result = await dispatchWithReceipt(
      makeReceipt({ stopReason: "error", error: "acpx prompt failed" }),
    );
    expect(result.delivered).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("reports not delivered when the reply turn is cancelled", async () => {
    const result = await dispatchWithReceipt(
      makeReceipt({ stopReason: "cancelled" }),
    );
    expect(result.delivered).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("reports not delivered when the reply turn is stopped", async () => {
    const result = await dispatchWithReceipt(
      makeReceipt({ stopReason: "stopped" }),
    );
    expect(result.delivered).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("reports not delivered when the receipt carries an error", async () => {
    const result = await dispatchWithReceipt(
      makeReceipt({ error: "acpx prompt failed" }),
    );
    expect(result.delivered).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("reports not delivered when the transport throws a terminal error", async () => {
    const sendToSession = vi.fn(async () => {
      throw new Error("session not found");
    });
    const emitSessionEvent = vi.fn();
    const result = await dispatchParentAgentDirective({
      runtime: makeRuntime(),
      acp: { sendToSession, emitSessionEvent } as never,
      sessionId: "child-session",
      args: { mode: "list-actions" },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(result.delivered).toBe(false);
    expect(result.ok).toBe(false);
  });
});

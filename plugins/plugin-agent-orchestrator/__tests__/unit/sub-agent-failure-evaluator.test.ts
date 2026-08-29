/**
 * Verifies subAgentFailureResponseEvaluator.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import type {
  Memory,
  MessageHandlerResult,
  ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { SIMPLE_CONTEXT_ID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { subAgentFailureResponseEvaluator } from "../../src/evaluators/sub-agent-failure.js";

function makeContext(overrides: {
  text?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  messageHandler?: Partial<MessageHandlerResult>;
}): ResponseHandlerEvaluatorContext {
  const messageHandler: MessageHandlerResult = {
    processMessage: "RESPOND",
    thought: "",
    plan: {
      contexts: ["general"],
      reply: "",
      requiresTool: true,
      ...overrides.messageHandler?.plan,
    },
    ...overrides.messageHandler,
  };
  const message = {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: {
      text:
        overrides.text ??
        "[sub-agent: text-my-ex (claude) — error]\nACP session failed: registration request timed out.",
      source: overrides.source ?? "sub_agent",
      metadata: {
        subAgent: true,
        subAgentEvent: "error",
        subAgentLabel: "text-my-ex",
        ...overrides.metadata,
      },
    },
  } as Memory;
  return {
    runtime: {} as never,
    message,
    state: {} as never,
    messageHandler,
    availableContexts: [{ id: SIMPLE_CONTEXT_ID, description: "simple" }],
  };
}

describe("subAgentFailureResponseEvaluator", () => {
  it("relays one honest failure message on a terminal error synthetic (no silence)", () => {
    const context = makeContext({});
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(true);
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe(
      `Couldn't finish the "text-my-ex" task — ACP session failed: registration request timed out. Want me to retry?`,
    );
    expect(result.requiresTool).toBe(false);
    expect(result.setContexts).toEqual([SIMPLE_CONTEXT_ID]);
    expect(result.clearCandidateActions).toBe(true);
    expect(result.clearParentActionHints).toBe(true);
  });

  it("also fires for state_lost_exhausted and round_trip_cap_exceeded", () => {
    for (const subAgentEvent of [
      "state_lost_exhausted",
      "round_trip_cap_exceeded",
    ]) {
      const context = makeContext({ metadata: { subAgentEvent } });
      expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(true);
    }
  });

  it("does NOT fire for a clean task_complete (that is the completion evaluator's job)", () => {
    const context = makeContext({
      metadata: { subAgentEvent: "task_complete" },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("fires for a verify-failed task_complete with no URL that probed live", () => {
    // The completion evaluator's gate steps aside for this shape (it requires
    // at least one live URL to relay a caveated deliverable), so without the
    // failure twin the outcome rides on the planner volunteering a reply.
    const context = makeContext({
      text: "[sub-agent: bean-bar (claude) — task_complete]\nBuild finished.\n[verification: the following URL(s) the sub-agent referenced are NOT reachable — do NOT tell the user the app is live]\n  - https://example.org/apps/bean-bar/ → HTTP 404",
      metadata: { subAgentEvent: "task_complete", subAgentLabel: "bean-bar" },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(true);
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toContain(`Couldn't finish the "bean-bar" task`);
  });

  it("does NOT fire for a verify-failed task_complete that still has a live URL", () => {
    // A caveated deliverable exists — the completion evaluator owns that turn.
    const context = makeContext({
      text: "[sub-agent: bean-bar (claude) — task_complete]\nBuild finished.\n[verification: the following URL(s) the sub-agent referenced are NOT reachable — do NOT tell the user the app is live]\n  - https://example.org/apps/bean-bar/style.css → HTTP 404",
      metadata: {
        subAgentEvent: "task_complete",
        subAgentLabel: "bean-bar",
        subAgentVerifiedUrls: ["https://example.org/apps/bean-bar/"],
      },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("fires when every metadata-verified URL is in the completion's dead list", () => {
    // Route-alias expansion can stamp a public URL as "verified" even though
    // its direct probe was dead; a dead-listed URL is not a deliverable.
    const context = makeContext({
      text: "[sub-agent: bean-bar (claude) — task_complete]\nBuild finished.\n[verification: the following URL(s) the sub-agent referenced are NOT reachable — do NOT tell the user the app is live]\n  - https://example.org/apps/bean-bar/ → HTTP 404",
      metadata: {
        subAgentEvent: "task_complete",
        subAgentLabel: "bean-bar",
        subAgentVerifiedUrls: ["https://example.org/apps/bean-bar/"],
      },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(true);
  });

  it("does NOT fire for non sub-agent messages", () => {
    const context = makeContext({
      source: "discord",
      metadata: { subAgent: false },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("defers to the planner when it is taking a concrete follow-up action", () => {
    const context = makeContext({
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "",
          requiresTool: true,
          candidateActions: ["TASKS_SEND_TO_AGENT"],
        },
      } as Partial<MessageHandlerResult>,
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it.each([
    ["candidate TASKS", { candidateActions: ["TASKS"] }],
    [
      "candidate TASKS_SPAWN_AGENT",
      { candidateActions: ["TASKS_SPAWN_AGENT"] },
    ],
    ["parent TASKS", { parentActionHints: ["TASKS"] }],
  ])("ignores stale generic task hints: %s", (_label, plan) => {
    const context = makeContext({
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "",
          requiresTool: true,
          ...plan,
        },
      } as Partial<MessageHandlerResult>,
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(true);
  });

  it("does NOT fire when the turn is already STOP", () => {
    const context = makeContext({
      messageHandler: { processMessage: "STOP" },
    });
    expect(subAgentFailureResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("uses a generic subject and omits the reason for label-less, noise-only narration", () => {
    const context = makeContext({
      text: "[internal-code-9931]",
      metadata: { subAgentLabel: undefined },
    });
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe("Couldn't finish that task. Want me to retry?");
  });

  // Regressions for #29852: the router's error narration is unedited content, so
  // a reason clause frequently already ends in sentence punctuation. The reply
  // template must contribute exactly one terminator — never doubling the one the
  // reason already carries — and must preserve `!`/`?` rather than overriding it.
  it("does not double a period when the reason already ends in one (#29852)", () => {
    const context = makeContext({
      text: "[sub-agent: text-my-ex (claude) — error]\nACP session failed: registration request timed out.",
    });
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe(
      `Couldn't finish the "text-my-ex" task — ACP session failed: registration request timed out. Want me to retry?`,
    );
    expect(result.reply).not.toContain("..");
  });

  it("does not double when the reason ends in a horizontal ellipsis (#29852)", () => {
    const context = makeContext({
      text: "[sub-agent: text-my-ex (claude) — error]\nWorkspace provisioning timed out…",
    });
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe(
      `Couldn't finish the "text-my-ex" task — Workspace provisioning timed out… Want me to retry?`,
    );
    expect(result.reply).not.toContain("….");
  });

  // The terminator class also carries the fullwidth/ideographic stops so a
  // sub-agent narrating in a language that uses them is not doubled. Each stop
  // is pinned independently: dropping any one member from SENTENCE_TERMINATOR
  // must turn one of these red, otherwise a later "simplify this regex" cleanup
  // could silently reintroduce the #29852 doubling for CJK narration.
  it.each([
    ["。", "ACP session failed: 接続がタイムアウトしました。"],
    ["！", "Sub-agent crashed: プロセスが異常終了しました！"],
    ["？", "Provisioning check: ワークスペースは完了しましたか？"],
  ])(
    "does not double when the reason already ends in the '%s' stop (#29852)",
    (stop, reason) => {
      const context = makeContext({
        text: `[sub-agent: text-my-ex (claude) — error]\n${reason}`,
      });
      const result = subAgentFailureResponseEvaluator.evaluate(context);
      expect(result.reply).toBe(
        `Couldn't finish the "text-my-ex" task — ${reason} Want me to retry?`,
      );
      expect(result.reply).not.toContain(`${stop}.`);
    },
  );

  it("preserves a reason's own '!' terminator without appending a period", () => {
    const context = makeContext({
      text: "[sub-agent: text-my-ex (claude) — error]\nSub-agent process crashed unexpectedly!",
    });
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe(
      `Couldn't finish the "text-my-ex" task — Sub-agent process crashed unexpectedly! Want me to retry?`,
    );
    expect(result.reply).not.toContain("!.");
  });

  it("preserves a reason's own '?' terminator without appending a period", () => {
    const context = makeContext({
      text: "[sub-agent: text-my-ex (claude) — error]\nDid the workspace ever finish provisioning?",
    });
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe(
      `Couldn't finish the "text-my-ex" task — Did the workspace ever finish provisioning? Want me to retry?`,
    );
    expect(result.reply).not.toContain("?.");
  });

  it("adds exactly one terminator to a reason with no trailing punctuation", () => {
    const context = makeContext({
      text: "[sub-agent: text-my-ex (claude) — error]\nState recovery budget exhausted after 3 attempts",
    });
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe(
      `Couldn't finish the "text-my-ex" task — State recovery budget exhausted after 3 attempts. Want me to retry?`,
    );
  });

  it("terminates the empty-reason path with exactly one period", () => {
    const context = makeContext({
      text: "[internal-code-9931]",
      metadata: { subAgentLabel: undefined },
    });
    const result = subAgentFailureResponseEvaluator.evaluate(context);
    expect(result.reply).toBe("Couldn't finish that task. Want me to retry?");
    expect(result.reply).not.toContain("..");
  });
});

/** Planner silence on a turn whose caller owes a reply gets one review. */
import type { ContextEvent, ContextObject, JsonValue } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../planner-loop";

/** The Stage-1 decision event the message service records on a turn's context. */
const stageOneEvent = (metadata: Record<string, JsonValue>): ContextEvent => ({
  id: "stage1",
  type: "message_handler",
  source: "message-service",
  metadata,
});

/** A planner model response carrying one native tool call. */
const plannerToolCall = (name: string, args: Record<string, JsonValue>) => ({
  text: "",
  toolCalls: [{ id: name.toLowerCase(), name, arguments: args }],
});

const ANSWER = "Looks solid; the nonce now settles before the response closes.";
const ignore = () => plannerToolCall("IGNORE", {});
const reply = () =>
  plannerToolCall("REPLY", { text: ANSWER, eliza_turn_scope: "final" });

const context = (): ContextObject => ({
  id: "silence-review",
  events: [
    stageOneEvent({
      plan: {
        replyEffectStatus: "pending",
        intents: ["review the commit diff"],
        reply: "",
      } satisfies Record<string, JsonValue>,
    }),
  ],
});

async function run(
  outputs: ReturnType<typeof plannerToolCall>[],
  replyOwed?: boolean,
) {
  const prompts: unknown[] = [];
  let tools = 0;
  const result = await runPlannerLoop({
    runtime: {
      useModel: async (_type: unknown, params: unknown) => {
        prompts.push(params);
        const output = outputs.shift();
        if (!output) throw new Error("Unexpected planner call");
        return output;
      },
    },
    context: context(),
    ...(replyOwed === undefined ? {} : { replyOwed }),
    tools: [
      {
        name: "LOOKUP",
        description: "Read the referenced commit.",
        parameters: { type: "object", properties: {} },
      },
    ],
    executeToolCall: async () => {
      tools++;
      return { success: true, text: "Commit 18b9ff2: 4 files changed." };
    },
    // Only the tool case reaches evaluation; it hands the turn back to the
    // planner, which then chooses silence.
    evaluate: async () => ({
      success: true,
      decision: "CONTINUE",
      thought: "The commit was read.",
    }),
  });
  const reviews = result.trajectory.context.events.filter((event) =>
    event.id.startsWith("silent-terminal-review:"),
  );
  return { result, reviews, plannerCalls: prompts.length, tools };
}

describe("planner silence on an owed reply", () => {
  it("returns IGNORE to the planner once and delivers its REPLY", async () => {
    const { result, reviews, plannerCalls } = await run(
      [ignore(), reply()],
      true,
    );
    expect(reviews).toHaveLength(1);
    expect(plannerCalls).toBe(2);
    expect(result.finalMessage).toBe(ANSWER);
    expect(result.endedWithDeliberateSilence).toBeUndefined();
  });

  it("ends silent after a single review when the planner repeats IGNORE", async () => {
    const { result, reviews, plannerCalls } = await run(
      [ignore(), ignore()],
      true,
    );
    expect(reviews).toHaveLength(1);
    expect(plannerCalls).toBe(2);
    expect(result.endedWithDeliberateSilence).toBe(true);
  });

  it.each([false, undefined])(
    "keeps silence final when no reply is owed (%s)",
    async (replyOwed) => {
      const { result, reviews, plannerCalls } = await run(
        [ignore()],
        replyOwed,
      );
      expect(reviews).toHaveLength(0);
      expect(plannerCalls).toBe(1);
      expect(result.endedWithDeliberateSilence).toBe(true);
    },
  );

  it("keeps silence final after a tool already ran", async () => {
    const { result, reviews, tools } = await run(
      [
        plannerToolCall("LOOKUP", { eliza_turn_scope: "more_work_pending" }),
        ignore(),
      ],
      true,
    );
    expect(tools).toBe(1);
    expect(reviews).toHaveLength(0);
    expect(result.endedWithDeliberateSilence).toBe(true);
  });
});

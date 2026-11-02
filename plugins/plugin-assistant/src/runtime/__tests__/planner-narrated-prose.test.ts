/** Narrated tool calls must survive prose in front of the JSON object. */
import type { ContextObject } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../planner-loop";

const ANSWER = "The referenced commit was read.";

const context = (): ContextObject => ({ id: "narrated-prose", events: [] });

const narratedLookup = (prose: string) =>
  `${prose} {"name":"LOOKUP","arguments":{"query":"commit 18b9ff2"}}`;

async function run(text: string) {
  let plannerCalls = 0;
  let tools = 0;
  const result = await runPlannerLoop({
    runtime: {
      useModel: async () => {
        plannerCalls++;
        if (plannerCalls === 1) {
          return { text, toolCalls: [] };
        }
        return {
          text: "",
          toolCalls: [
            {
              id: "reply",
              name: "REPLY",
              arguments: { text: ANSWER, eliza_turn_scope: "final" },
            },
          ],
        };
      },
    },
    context: context(),
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
    evaluate: async () => ({
      success: true,
      decision: "CONTINUE",
      thought: "The commit was read.",
    }),
  });
  return { result, plannerCalls, tools };
}

describe("planner narrated calls behind prose", () => {
  it("recovers a narrated call behind clean prose", async () => {
    const { result, plannerCalls, tools } = await run(
      narratedLookup("Calling the tool now:"),
    );
    expect(tools).toBe(1);
    expect(plannerCalls).toBe(2);
    expect(result.finalMessage).toBe(ANSWER);
  });

  it("recovers a narrated call after an unclosed brace in prose", async () => {
    const { result, plannerCalls, tools } = await run(
      narratedLookup("Use {name as a placeholder, then call:"),
    );
    expect(tools).toBe(1);
    expect(plannerCalls).toBe(2);
    expect(result.finalMessage).toBe(ANSWER);
  });

  it("recovers a narrated call after a stray quote in prose", async () => {
    const { result, plannerCalls, tools } = await run(
      narratedLookup('It is a 5" screen, calling:'),
    );
    expect(tools).toBe(1);
    expect(plannerCalls).toBe(2);
    expect(result.finalMessage).toBe(ANSWER);
  });
});

/**
 * A promoted family exposes the umbrella (discriminator required) as the
 * sub-planner's one tool. The execute wrapper renamed the recorded call to
 * the child, so an identical umbrella call re-emitted on the next round was
 * never matched by the settled-call guard and the effect ran twice.
 */
import {
  type Action,
  type IAgentRuntime,
  promoteSubactionsToActions,
  stringToUuid,
} from "@elizaos/core";
import { expect, it } from "vitest";
import type { PlannerRuntime } from "./planner-loop.ts";
import { runSubPlanner } from "./sub-planner.ts";

const parent: Action = {
  name: "MESSAGE",
  description: "Send or list messages.",
  parameters: [
    {
      name: "action",
      description: "Operation.",
      required: true,
      schema: { type: "string", enum: ["send", "list"] },
    },
    { name: "target", description: "Recipient.", schema: { type: "string" } },
    { name: "text", description: "Message text.", schema: { type: "string" } },
  ],
  validate: async () => true,
  handler: async () => ({ success: true }),
};
const [umbrella, ...children] = promoteSubactionsToActions(parent);

it("runs an identical umbrella call re-emitted on the next round once", async () => {
  const sendCall = {
    id: "send",
    name: "MESSAGE",
    arguments: { action: "send", target: "Alice", text: "running late" },
  };
  let rounds = 0;
  const executed: string[] = [];
  const runtime = {
    agentId: stringToUuid("agent"),
    actions: [umbrella, ...children],
    useModel: async (_type: unknown, params: { tools?: unknown[] }) => {
      // The evaluator shares the model port. It is not satisfied after the
      // first send, so the planner is asked again.
      if (!params?.tools) {
        return JSON.stringify({
          decision: "CONTINUE",
          success: false,
          thought: "Check the delivery before answering.",
          requestFullyCovered: false,
        });
      }
      rounds += 1;
      if (rounds <= 2)
        return { text: "", toolCalls: [{ ...sendCall, id: `send-${rounds}` }] };
      return {
        text: "",
        toolCalls: [
          { id: "reply", name: "REPLY", arguments: { text: "Told Alice." } },
        ],
      };
    },
  } as unknown as IAgentRuntime & PlannerRuntime;

  const result = await runSubPlanner({
    runtime,
    action: umbrella,
    context: { id: "message-family", events: [] },
    ctx: {
      message: {
        id: stringToUuid("message"),
        agentId: runtime.agentId,
        roomId: stringToUuid("room"),
        entityId: stringToUuid("owner"),
        createdAt: 1000,
        content: { text: "tell Alice I'm running late" },
      },
      userRoles: ["OWNER"],
    },
    execute: async (_runtime, _ctx, toolCall) => {
      executed.push(toolCall.name);
      return { success: true, text: "Sent." };
    },
  });

  expect({
    executed,
    stepNames: result.trajectory.steps.map(
      (step) => step.toolCall?.name ?? step.terminalMessage,
    ),
    feedback: result.trajectory.context.events
      .filter((event) => event.id?.startsWith("redundant-tool-call:"))
      .map((event) => event.id),
  }).toEqual({
    executed: ["MESSAGE_SEND"],
    stepNames: ["MESSAGE_SEND", "Told Alice."],
    feedback: ["redundant-tool-call:2"],
  });
});

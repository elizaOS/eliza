/** An accepted async handoff delivers Stage 1's held ack without synthesis, rescue or reply recovery. */
import { ChannelType, ModelType } from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.js";
import { ACCEPTED_SPAWN_RECEIPT } from "../../runtime/__tests__/receipts";

describe("accepted async handoff through the message pipeline", () => {
  it("delivers the held Stage-1 ack with one planner call", async () => {
    const draft = "on it. building the page now, will ping you when it's live.";
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["general"],
        intents: ["build the demo page"],
        candidateActionNames: ["BUILD_SPAWN"],
        replyText: draft,
        extra: { replyEffectStatus: "pending" },
      }),
      {
        text: "",
        toolCalls: [
          {
            id: "spawn",
            name: "BUILD_SPAWN",
            arguments: {
              task: "Build a demo page.",
              eliza_turn_scope: "final",
            },
          },
        ],
      },
    ]);
    runtime.actions = [
      {
        name: "BUILD_SPAWN",
        description: "Delegate a coding build to a background sub-agent.",
        contexts: ["general"],
        asyncHandoff: true,
        suppressEarlyReply: true,
        parameters: [{ name: "task", schema: { type: "string" } }],
        validate: async () => true,
        handler: vi.fn(async () => ({
          success: true,
          text: "Spawned a coding sub-agent. Its result arrives later as a follow-up message.",
          effectReceipts: [ACCEPTED_SPAWN_RECEIPT],
          data: { actionName: "BUILD_SPAWN" },
          continueChain: false,
        })),
      },
    ] as never;
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "build me a demo page",
        channelType: ChannelType.DM,
      }),
    });
    expect(result).toMatchObject({
      kind: "planned_reply",
      result: { responseContent: { text: draft } },
    });
    // Stage 1 and one planner call; no synthesis, rescue, recovery or review.
    expect(useModelCalls(runtime).map(([type]) => type)).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
    ]);
  });
});

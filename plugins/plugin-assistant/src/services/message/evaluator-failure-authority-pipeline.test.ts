/** The message pipeline's planner evaluator receives the loop's failure authority. */
import { ChannelType } from "@elizaos/core/protocol";
import { expect, it } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.js";

// A failed tool's verified text is already user-visible, so it must not buy a retry round.
it("ships a failed tool's verified text without a silent-finish retry", async () => {
  const toolText = "That record is locked, so I couldn't rename it.";
  const runtime = makeRuntime([
    stage1Response({
      contexts: ["general"],
      candidateActionNames: ["WRITE_RECORD"],
      intents: ["rename the record"],
      extra: { replyEffectStatus: "pending" },
    }),
    {
      text: "",
      toolCalls: [
        {
          id: "write",
          name: "WRITE_RECORD",
          arguments: { eliza_turn_scope: "final" },
        },
      ],
    },
    // The model ignores the failure rule; the runtime flips the verdict.
    JSON.stringify({
      thought: "",
      success: true,
      decision: "FINISH",
      messageToUser: "",
      replyEffectStatus: "none",
    }),
  ]);
  runtime.actions = [
    {
      name: "WRITE_RECORD",
      description: "Rename the fixture record",
      contexts: ["general"],
      parameters: [],
      validate: async () => true,
      handler: async () => ({
        success: false,
        error: "RECORD_LOCKED",
        text: toolText,
        userFacingText: toolText,
        verifiedUserFacing: true,
        data: { actionName: "WRITE_RECORD" },
      }),
    },
  ] as never;
  const outcome = await runStage1({
    runtime,
    message: makeMessage({
      text: "Rename the fixture record to amber.",
      channelType: ChannelType.DM,
    }),
  });
  if (outcome.kind !== "planned_reply") throw new Error("expected a reply");
  expect(useModelCalls(runtime)).toHaveLength(3);
  expect(outcome.result.responseContent?.text).toBe(toolText);
  expect(outcome.result).toMatchObject({ requestFulfilled: false });
});

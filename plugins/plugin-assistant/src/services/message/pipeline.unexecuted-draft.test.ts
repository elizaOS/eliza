/** A planning failure after Stage 1 declared work does not deliver the draft as the answer. */
import { ChannelType, ModelType } from "@elizaos/core/protocol";
import { describe, expect, it } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.js";

const DRAFT = "i couldn't find that reminder, so there is nothing to cancel.";

// Stage 1 drafts beside its intents and the turn is promoted to planning, as
// a routed domain request is; no planner response is queued, so planning fails.
function failedPlanningTurn(intents: string[]) {
  const runtime = makeRuntime(
    [
      stage1Response({
        contexts: ["general"],
        intents,
        replyText: DRAFT,
        extra: { replyEffectStatus: "none" },
      }),
    ],
    undefined,
    [
      {
        name: "test-promote-to-planning",
        priority: 100,
        shouldRun: () => true,
        evaluate: () => ({ reply: "On it.", requiresTool: true }),
      },
    ],
  );
  const turn = runStage1({
    runtime,
    message: makeMessage({
      text: "cancel the bill reminder",
      channelType: ChannelType.DM,
    }),
  });
  return { runtime, turn };
}

describe("planner failure after a draft beside declared work", () => {
  it("fails the turn instead of delivering the unexecuted draft", async () => {
    await expect(
      failedPlanningTurn(["cancel the bill reminder"]).turn,
    ).rejects.toThrow("Unexpected useModel call");
  });

  it("still degrades to a complete answer that declared no work", async () => {
    const { runtime, turn } = failedPlanningTurn([]);
    expect(await turn).toMatchObject({
      kind: "direct_reply",
      result: { responseContent: { text: DRAFT } },
    });
    expect(useModelCalls(runtime).map(([type]) => type)).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
    ]);
  });
});

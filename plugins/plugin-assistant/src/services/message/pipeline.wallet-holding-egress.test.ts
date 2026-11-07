/** A reply that states an unobserved wallet holding never egresses, on either reply path. */
import { ChannelType } from "@elizaos/core/protocol";
import { describe, expect, it } from "vitest";
import {
  acceptedRecoveryReview,
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
} from "../../__tests__/stage1/fixtures.js";

const RECOVERED = "I can't see your wallet balance right now.";

async function runHoldingTurn(stageOne: unknown, plannerCalls: unknown[]) {
  const runtime = makeRuntime([
    stageOne,
    ...plannerCalls,
    JSON.stringify({ response: RECOVERED }),
    acceptedRecoveryReview(
      "The candidate says the balance is not visible and asserts no holding.",
    ),
  ]);
  const result = await runStage1({
    runtime,
    message: makeMessage({
      text: "how much sol do i have?",
      channelType: ChannelType.DM,
    }),
  });
  const rejections = (
    runtime.logger.warn as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.filter(
    ([fields]) => (fields as { kind?: string }).kind === "financial_holding",
  );
  return { result, rejections };
}

describe("wallet holding egress through the message pipeline", () => {
  it("rejects a planner reply that fabricates a balance in a wallet turn", async () => {
    const { result, rejections } = await runHoldingTurn(
      stage1Response({
        contexts: ["wallet"],
        intents: ["check the wallet balance"],
        replyText: "",
      }),
      [
        {
          text: "",
          toolCalls: [
            {
              id: "reply-1",
              name: "REPLY",
              arguments: { text: "You have 120 BONK." },
            },
          ],
        },
      ],
    );
    expect(result).toMatchObject({
      kind: "planned_reply",
      result: { responseContent: { text: RECOVERED } },
    });
    expect(rejections).not.toHaveLength(0);
  });

  it("rejects a direct Stage 1 reply that fabricates a balance for a holdings question", async () => {
    const { result } = await runHoldingTurn(
      stage1Response({
        contexts: ["simple"],
        intents: [],
        replyText: "You have 120 SOL.",
      }),
      [],
    );
    expect(result).toMatchObject({
      kind: "direct_reply",
      result: { responseContent: { text: RECOVERED } },
    });
  });
});

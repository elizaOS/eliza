import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { renderGroundedActionReply } from "./grounded-action-reply.js";

describe("renderGroundedActionReply", () => {
  it("uses TEXT_SMALL and includes recent conversation plus action history", async () => {
    const modelCalls: Array<{
      modelType: ModelTypeName;
      params: unknown;
    }> = [];
    const runtime = {
      async useModel(modelType: ModelTypeName, params: unknown) {
        modelCalls.push({ modelType, params });
        return "Here’s the updated reply.";
      },
      character: {
        name: "Eliza",
        style: { chat: ["brief", "natural"] },
      },
    } as unknown as IAgentRuntime;
    const message = {
      content: {
        text: "rewrite that reply to say I'm in San Francisco",
      },
    } as Memory;
    const state = {
      values: {
        recentMessages:
          "user: can you try the Suran search again?\nassistant: Here are the emails from Suran.",
      },
      data: {
        actionResults: [
          {
            success: true,
            text: "Drafted a reply to From Suran",
            data: {
              actionName: "GMAIL",
              subject: "From Suran",
            },
          },
        ],
      },
    } as unknown as State;

    const text = await renderGroundedActionReply({
      runtime,
      message,
      state,
      intent: "rewrite that reply to say I'm in San Francisco",
      domain: "gmail",
      scenario: "draft_reply",
      fallback: "Here is the draft.",
      context: {
        subject: "From Suran",
      },
      preferCharacterVoice: true,
    });

    expect(text).toBe("Here’s the updated reply.");
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]?.modelType).toBe(ModelType.TEXT_SMALL);
    expect(modelCalls[0]?.params).toEqual(
      expect.objectContaining({
        prompt: expect.any(String),
      }),
    );

    const prompt = (modelCalls[0]?.params as { prompt?: string } | undefined)
      ?.prompt;
    expect(prompt).toEqual(expect.any(String));
    expect(prompt).toContain("Recent conversation:");
    expect(prompt).toContain("can you try the Suran search again?");
    expect(prompt).toContain("Recent action history:");
    expect(prompt).toContain("Drafted a reply to From Suran");
    expect(prompt).toContain("Active trajectory summary:");
    expect(prompt).toContain("Canonical fallback:");
  });

  it("falls back when the small model returns structured output", async () => {
    const runtime = {
      async useModel() {
        return '{"reply":"bad"}';
      },
    } as unknown as IAgentRuntime;

    const text = await renderGroundedActionReply({
      runtime,
      message: {
        content: { text: "what's left today?" },
      } as Memory,
      state: undefined,
      intent: "what's left today?",
      domain: "lifeops",
      scenario: "overview",
      fallback: "You have 2 tasks left today.",
    });

    expect(text).toBe("You have 2 tasks left today.");
  });
});

import { ChannelType } from "@elizaos/core/protocol";
import { expect, it, vi } from "vitest";
import {
  reviewedHistoryFixture,
  runStage1,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

it.each([ChannelType.DM, ChannelType.VOICE_DM])(
  "uses a valid background checkpoint without a second decision call: %s",
  async (channelType) => {
    const { runtime, message, rows, state } = await reviewedHistoryFixture();
    message.content.channelType = channelType;
    const before = structuredClone(rows);
    runtime.useModel = vi.fn(async () =>
      stage1Response({
        contexts: ["simple"],
        replyParts: true,
        replyText: "Hello.",
      }),
    );
    const result = await runStage1({ runtime, message, state });
    expect(result.kind).toBe("direct_reply");
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    const params = useModelCalls(runtime)[0][1] as {
      messages: unknown;
      tools: unknown;
    };
    const wire = JSON.stringify(params.messages);
    expect(wire).toContain("Never change my records");
    expect(wire).not.toContain("blueberry");
    expect(wire).toContain("history:all");
    expect(wire).toContain("For a specific saved-fact lookup, first");
    expect(wire).toContain("inspect matched originals and their corrections");
    expect(wire).toContain("before claiming something was never discussed");
    expect(JSON.stringify(params.tools)).toContain(
      "advertised stored-memory reference",
    );
    expect(JSON.stringify(params.tools)).not.toContain('"completionContext"');
    expect(rows).toEqual(before);
  },
);

it.each(["history:all", "history:h2", "history:search-user:blueberry"])(
  "offers foreground selection only after full native restoration: %s",
  async (reference) => {
    const { runtime, message, rows, state } = await reviewedHistoryFixture();
    const before = structuredClone(rows);
    let calls = 0;
    runtime.useModel = vi.fn(async (_type, params) => {
      calls++;
      const wire = JSON.stringify(params);
      if (calls === 1) {
        expect(wire).not.toContain("blueberry");
        return {
          text: "",
          toolCalls: [
            {
              id: "read",
              name: "READ_CONTEXT",
              arguments: { contextRequests: [reference] },
            },
          ],
        };
      }
      expect(wire).toContain("blueberry");
      const tools = params.tools as Array<{
        name: string;
        parameters: { properties?: Record<string, unknown> };
      }>;
      expect(
        Boolean(
          tools.find((tool) => tool.name === "HANDLE_RESPONSE")?.parameters
            .properties?.completionContext,
        ),
      ).toBe(reference === "history:all");
      expect(wire.includes("History selection:")).toBe(
        reference === "history:all",
      );
      return stage1Response({
        contexts: ["simple"],
        replyParts: true,
        replyText: "The earlier label was blueberry.",
      });
    });
    const result = await runStage1({ runtime, message, state });
    expect(result.kind).toBe("direct_reply");
    expect(calls).toBe(2);
    expect(rows).toEqual(before);
  },
);

it("carries background history through the real planned-turn handoff without another review call", async () => {
  const { runtime, message, rows, state } = await reviewedHistoryFixture();
  message.content.text =
    "Read the current calendar record without changing anything.";
  const before = structuredClone(rows);
  const handler = vi.fn(async (_runtime, _message, actionState) => {
    const supplied = String(actionState?.values.selectedActionConversation);
    expect(supplied).not.toContain("blueberry");
    expect(supplied).toContain("Never change my records");
    return {
      success: true,
      text: "The record says violet.",
      transcriptVisibility: "internal" as const,
      modelReplyRequired: true,
    };
  });
  runtime.actions = [
    {
      name: "CALENDAR_READ",
      description: "Read current calendar record",
      contexts: ["calendar"],
      validate: async () => true,
      handler,
    },
  ];
  let calls = 0;
  runtime.useModel = vi.fn(async (_type, params) => {
    calls++;
    const wire = JSON.stringify(params);
    expect(wire).toContain("Never change my records");
    expect(wire).not.toContain("blueberry");
    if (calls === 1)
      return stage1Response({
        contexts: ["calendar"],
        intents: ["Read current calendar record"],
        candidateActionNames: ["CALENDAR_READ"],
        replyText: "",
        extra: { requiresTool: true, replyEffectStatus: "pending" },
      });
    if (calls === 2) {
      expect(wire).toContain("RESTORE_CONTEXT");
      expect(wire).not.toContain("eliza_completion_context");
      return {
        text: "",
        toolCalls: [{ id: "read-once", name: "CALENDAR_READ", arguments: {} }],
      };
    }
    if (calls === 3)
      return JSON.stringify({
        thought: "The read settled the request.",
        success: true,
        decision: "FINISH",
        messageToUser: "The record says violet.",
      });
    throw new Error("Unexpected model retry");
  });
  const result = await runStage1({ runtime, message, state });
  expect(result.kind).toBe("planned_reply");
  if (result.kind === "planned_reply")
    expect(result.result.responseContent?.text).toBe("The record says violet.");
  expect(calls).toBe(3);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(rows).toEqual(before);
});

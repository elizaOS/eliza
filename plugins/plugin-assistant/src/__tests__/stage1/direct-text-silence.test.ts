import { ChannelType, ModelType, type UUID } from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import { runV5MessageRuntimeStage1 } from "../../services/message.js";
import {
  makeMessage,
  makeRuntime,
  makeState,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

// The protocol action is registered after candidate admission. A sole explicit
// discovery hint must not look unresolved and fall back to broad domain tools.
describe("direct-text silence review", () => {
  it.each(["STOP", "IGNORE"] as const)(
    "repairs contradictory %s before executing requested work",
    async (terminal) => {
      const action = vi.fn(async () => ({
        success: true,
        text: "verified hash receipt",
      }));
      const runtime = makeRuntime([
        stage1Response({
          shouldRespond: terminal,
          contexts: ["simple"],
          intents: ["hash text"],
          replyText: "UNVERIFIED_RESULT_MUST_NOT_SHIP",
          extra: { replyEffectStatus: "none" },
        }),
        stage1Response({
          contexts: ["general"],
          candidateActionNames: ["HASH_TEXT"],
          intents: ["hash text"],
          replyText: "Checking.",
          extra: { replyEffectStatus: "pending" },
        }),
        {
          text: "",
          toolCalls: [
            {
              id: "hash-after-repair",
              name: "HASH_TEXT",
              arguments: { eliza_turn_scope: "final" },
            },
          ],
        },
        JSON.stringify({
          decision: "FINISH",
          success: true,
          thought: "Receipt verified.",
          messageToUser: "verified hash receipt",
        }),
      ]);
      runtime.actions = [
        {
          name: "HASH_TEXT",
          description: "Hash the requested text.",
          contexts: ["general"],
          parameters: [],
          similes: [],
          examples: [],
          validate: async () => true,
          handler: action,
        },
      ] as never;
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          text: "Hash this text using HASH_TEXT.",
          channelType: ChannelType.DM,
        }),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      });
      expect(action).toHaveBeenCalledTimes(1);
      const calls = useModelCalls(runtime);
      const before = calls[0][1] as { messages: unknown[] };
      const after = calls[1][1] as { messages: unknown[] };
      expect(after.messages).toEqual([...before.messages, expect.any(Object)]);
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply")
        expect(result.result.responseContent?.text).toBe(
          "verified hash receipt",
        );
    },
  );
  it("lets a repaired terminal declaration confirm disengagement without effects", async () => {
    const runtime = makeRuntime([
      stage1Response({
        shouldRespond: "STOP",
        contexts: ["simple"],
        candidateActionNames: ["HASH_TEXT"],
      }),
      stage1Response({ shouldRespond: "STOP", contexts: ["simple"] }),
    ]);
    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({
        text: "Stop; do not run HASH_TEXT.",
        channelType: ChannelType.DM,
      }),
      state: makeState(),
      responseId: "00000000-0000-0000-0000-000000000009" as UUID,
    });
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") expect(result.action).toBe("STOP");
  });
  it("rejects repeated terminal-work contradictions before fields or tools", async () => {
    const contradiction = stage1Response({
      shouldRespond: "STOP",
      contexts: ["simple"],
      intents: ["hash text"],
    });
    const runtime = makeRuntime([contradiction, contradiction]);
    const dispatch = vi.spyOn(runtime.responseHandlerFieldRegistry, "dispatch");
    const action = vi.fn(async () => ({ success: true, text: "must not run" }));
    runtime.actions = [
      {
        name: "HASH_TEXT",
        description: "Hash text.",
        contexts: ["general"],
        parameters: [],
        similes: [],
        examples: [],
        validate: async () => true,
        handler: action,
      },
    ] as never;
    await expect(
      runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          text: "Hash this text.",
          channelType: ChannelType.DM,
        }),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      }),
    ).rejects.toMatchObject({ code: "STAGE1_ROUTING_CONFLICT" });
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(action).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "honors requested context reads before reviewing silence with terminal opt-in=%s",
    async (optIn) => {
      const full =
        "Standing instruction: keep all records unchanged. The saved label is violet.";
      const runtime = makeRuntime(
        [
          stage1Response({
            shouldRespond: "IGNORE",
            contexts: ["simple"],
            contextRequests: ["userPersonalityPreferences"],
          }),
          stage1Response({ shouldRespond: "IGNORE", contexts: ["simple"] }),
          stage1Response({
            contexts: ["simple"],
            replyText: "The label was violet.",
            extra: { replyEffectStatus: "none" },
          }),
        ],
        optIn
          ? { ELIZA_STAGE1_TERMINAL_REASK: "1" }
          : { ELIZA_STAGE1_TERMINAL_REASK: "0" },
      );
      const state = makeState();
      state.data.providers = {
        userPersonalityPreferences: {
          text: full,
          discoveryText: "context_discovery: userPersonalityPreferences",
        },
      };
      runtime.composeState = vi.fn(async () => structuredClone(state));
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          text: "What was the saved label?",
          channelType: ChannelType.DM,
        }),
        state,
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      });
      const calls = useModelCalls(runtime);
      expect(calls).toHaveLength(3);
      expect(JSON.stringify(calls[0][1])).not.toContain(full);
      expect(JSON.stringify(calls[1][1])).toContain(full);
      const before = calls[1][1] as { messages: unknown[] };
      const after = calls[2][1] as { messages: unknown[] };
      expect(after.messages).toEqual([...before.messages, expect.any(Object)]);
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply")
        expect(result.result.responseContent?.text).toBe(
          "The label was violet.",
        );
    },
  );
  it.each([
    [true, "STOP", 3],
    [true, "RESPOND", 3],
    [false, "STOP", 2],
  ] as const)(
    "reviews STOP after requested context: optIn=%s result=%s calls=%s",
    async (optIn, reviewedDecision, expectedCalls) => {
      const full =
        "Standing instruction: keep all records unchanged. The saved label is violet.";
      const runtime = makeRuntime(
        [
          stage1Response({
            shouldRespond: "STOP",
            contexts: ["simple"],
            contextRequests: ["userPersonalityPreferences"],
          }),
          stage1Response({ shouldRespond: "STOP", contexts: ["simple"] }),
          stage1Response({
            shouldRespond: reviewedDecision,
            contexts: ["simple"],
            replyText:
              reviewedDecision === "RESPOND" ? "The label was violet." : "",
            extra: { replyEffectStatus: "none" },
          }),
        ],
        optIn
          ? { ELIZA_STAGE1_TERMINAL_REASK: "1" }
          : { ELIZA_STAGE1_TERMINAL_REASK: "0" },
      );
      const state = makeState();
      state.data.providers = {
        userPersonalityPreferences: {
          text: full,
          discoveryText: "context_discovery: userPersonalityPreferences",
        },
      };
      runtime.composeState = vi.fn(async () => structuredClone(state));
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          text: "What was the saved label?",
          channelType: ChannelType.DM,
        }),
        state,
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      });
      const calls = useModelCalls(runtime);
      expect(calls.map(([type]) => type)).toEqual(
        Array.from({ length: expectedCalls }, () => ModelType.RESPONSE_HANDLER),
      );
      expect(JSON.stringify(calls[0][1])).not.toContain(full);
      expect(JSON.stringify(calls[1][1])).toContain(full);
      if (optIn) {
        const before = calls[1][1] as { messages: unknown[] };
        const after = calls[2][1] as { messages: unknown[] };
        expect(after.messages).toEqual([
          ...before.messages,
          expect.any(Object),
        ]);
      }
      if (reviewedDecision === "STOP") {
        expect(result).toMatchObject({ kind: "terminal", action: "STOP" });
      } else {
        expect(result.kind).toBe("direct_reply");
        if (result.kind === "direct_reply")
          expect(result.result.responseContent?.text).toBe(
            "The label was violet.",
          );
      }
    },
  );

  it("rechecks an ignored direct request with every original message intact", async () => {
    const runtime = makeRuntime([
      stage1Response({ shouldRespond: "IGNORE", contexts: ["simple"] }),
      stage1Response({
        contexts: ["simple"],
        replyText: "The label was violet.",
        extra: { replyEffectStatus: "none" },
      }),
    ]);
    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({
        text: "What label did I give you? Keep my records unchanged.",
        channelType: ChannelType.DM,
      }),
      state: makeState(),
      responseId: "00000000-0000-0000-0000-000000000009" as UUID,
    });
    const calls = useModelCalls(runtime);
    expect(calls.map(([type]) => type)).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.RESPONSE_HANDLER,
    ]);
    const before = calls[0][1] as { messages: unknown[] };
    const after = calls[1][1] as { messages: unknown[] };
    expect(after.messages).toEqual([...before.messages, expect.any(Object)]);
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply")
      expect(result.result.responseContent?.text).toBe("The label was violet.");
  });
  it.each([
    {
      decision: "IGNORE" as const,
      text: "Please stay silent.",
      channel: ChannelType.DM,
      bot: false,
      calls: 2,
    },
    {
      decision: "STOP" as const,
      text: "Stop responding.",
      channel: ChannelType.DM,
      bot: false,
      calls: 2,
    },
    {
      decision: "IGNORE" as const,
      text: "thanks",
      channel: ChannelType.GROUP,
      bot: false,
      calls: 1,
    },
    {
      decision: "IGNORE" as const,
      text: "uh huh",
      channel: ChannelType.VOICE_DM,
      bot: false,
      calls: 2,
    },
    {
      decision: "IGNORE" as const,
      text: "automated update",
      channel: ChannelType.DM,
      bot: true,
      calls: 1,
    },
  ])(
    "retains $decision on $channel bot=$bot without delivery",
    async ({ decision, text, channel, bot, calls }) => {
      const response = stage1Response({
        shouldRespond: decision,
        contexts: ["simple"],
      });
      const runtime = makeRuntime(
        Array.from({ length: calls }, () => response),
      );
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          text,
          channelType: channel,
          metadata: { fromBot: bot },
        }),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      });
      expect(useModelCalls(runtime)).toHaveLength(calls);
      expect(result.kind).toBe("terminal");
      if (result.kind === "terminal") expect(result.action).toBe(decision);
    },
  );
});

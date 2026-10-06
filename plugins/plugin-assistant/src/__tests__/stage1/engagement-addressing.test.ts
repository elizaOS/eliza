import type { Memory } from "@elizaos/core/protocol";
import { ChannelType, type UUID } from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  reportErrorCalls,
  runStage1,
  stage1Response,
  useModelCalls,
  withReplyGateMode,
  withReplyGateSlots,
  withRoomEntities,
} from "./fixtures.js";

describe("runV5MessageRuntimeStage1 — engagement addressing gate", () => {
  // Live incident: in a busy multi-user group channel the agent replied to
  // turns its own Stage-1 output tagged as addressed to another participant
  // (27 posts in 20 minutes). The gate extends #9874's addressing signal from
  // tool promotion to the full reply / planner / early-ack routing.

  it("ignores a simple-path turn in every supported text-group channel", async () => {
    for (const channelType of [
      ChannelType.GROUP,
      ChannelType.THREAD,
      ChannelType.WORLD,
      ChannelType.FORUM,
      ChannelType.FEED,
    ]) {
      const runtime = withRoomEntities(
        makeRuntime([
          stage1Response({
            thought: "Overheard.",
            contexts: ["simple"],
            replyText: "I can help with that!",
            addressedTo: ["Alice"],
          }),
        ]),
      );
      const result = await runStage1({
        runtime,
        message: makeMessage({
          text: "Alice, can you take a look?",
          channelType,
        }),
        responseId: "00000000-0000-0000-0000-0000000000b1" as UUID,
      });
      expect(result.kind, channelType).toBe("terminal");
      if (result.kind === "terminal") {
        expect(result.action, channelType).toBe("IGNORE");
      }
    }
  });

  it("ignores an addressed-to-other mixed-context turn — planner never entered, no early ack emitted", async () => {
    const runtime = withRoomEntities(
      makeRuntime([
        stage1Response({
          thought: "Overheard with tool hints.",
          contexts: ["simple", "calendar"],
          candidateActionNames: ["CALENDAR"],
          replyText: "On it.",
          addressedTo: ["Alice"],
        }),
      ]),
    );
    const onResponseHandlerEarlyReply = vi.fn(async () => true);
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "Alice, can you check the calendar?",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-0000000000b2" as UUID,
      onResponseHandlerEarlyReply,
    });
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") {
      expect(result.action).toBe("IGNORE");
    }
    // Stage 1 was the only model call — the planner never ran.
    expect(useModelCalls(runtime)).toHaveLength(1);
    expect(onResponseHandlerEarlyReply).not.toHaveBeenCalled();
  });

  it("gates identically whether the addressee is a bot or a human participant (uniform)", async () => {
    for (const addressee of ["OtherBot", "Alice"]) {
      const runtime = withRoomEntities(
        makeRuntime([
          stage1Response({
            thought: "Overheard.",
            contexts: ["simple"],
            replyText: "Sure thing!",
            addressedTo: [addressee],
          }),
        ]),
      );
      const result = await runStage1({
        runtime,
        message: makeMessage({
          text: `${addressee}, your turn`,
          channelType: ChannelType.GROUP,
        }),
        responseId: "00000000-0000-0000-0000-0000000000b3" as UUID,
      });
      expect(result.kind).toBe("terminal");
      if (result.kind === "terminal") {
        expect(result.action).toBe("IGNORE");
      }
    }
  });

  it("keeps direct replies for every non-ambient turn class", async () => {
    const cases = [
      { label: "DM", content: { channelType: ChannelType.DM } },
      { label: "API", content: { channelType: ChannelType.API } },
      { label: "SELF", content: { channelType: ChannelType.SELF } },
      {
        label: "client chat",
        content: { channelType: ChannelType.GROUP, source: "client_chat" },
      },
      {
        label: "autonomous",
        content: {
          channelType: ChannelType.GROUP,
          metadata: { isAutonomous: true },
        },
      },
      {
        label: "sub-agent relay",
        content: { channelType: ChannelType.GROUP, source: "sub_agent" },
      },
      { label: "unknown channel", content: {} },
    ] satisfies Array<{
      label: string;
      content: Partial<Memory["content"]>;
    }>;

    for (const testCase of cases) {
      const runtime = withRoomEntities(
        makeRuntime([
          stage1Response({
            thought: `Direct ${testCase.label} turn.`,
            contexts: ["simple"],
            replyText: "I can help.",
            addressedTo: ["Alice"],
          }),
        ]),
      );
      const result = await runStage1({
        runtime,
        message: makeMessage({
          text: "Alice, can you take a look?",
          ...testCase.content,
        }),
        responseId: "00000000-0000-0000-0000-0000000000ba" as UUID,
      });

      expect(result.kind, testCase.label).toBe("direct_reply");
    }
  });

  it("preserves planner entry and its early ack for an unknown channel", async () => {
    const runtime = withRoomEntities(
      makeRuntime([
        stage1Response({
          thought: "Unknown channel needs planning.",
          contexts: ["general"],
          replyText: "I'll check that now.",
          addressedTo: ["Alice"],
          extra: { requiresTool: true },
        }),
        JSON.stringify({
          thought: "Finished the check.",
          toolCalls: [],
          messageToUser: "The check is complete.",
        }),
      ]),
    );
    const earlyReply = vi.fn(async () => true);
    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "Alice, can you check this?" }),
      responseId: "00000000-0000-0000-0000-0000000000bb" as UUID,
      onResponseHandlerEarlyReply: earlyReply,
    });

    expect(result.kind).toBe("planned_reply");
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(earlyReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "I'll check that now." }),
    );
  });

  it("does not gate undirected banter (addressedTo: []) — the simple reply ships unchanged", async () => {
    const runtime = withRoomEntities(
      makeRuntime([
        stage1Response({
          thought: "Undirected.",
          contexts: ["simple"],
          replyText: "Hello everyone.",
          addressedTo: [],
        }),
      ]),
    );
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "morning all",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-0000000000b4" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("Hello everyone.");
    }
  });

  it("does not gate a turn that names the agent alongside another participant", async () => {
    const runtime = withRoomEntities(
      makeRuntime([
        stage1Response({
          thought: "We are among the addressees.",
          contexts: ["simple"],
          replyText: "Happy to help.",
          addressedTo: ["Alice"],
        }),
      ]),
    );
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "Test Agent and Alice, thoughts?",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-0000000000b5" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
  });

  it("bypasses the gate on a platform mention or reply even when addressedTo names another participant", async () => {
    for (const mentionContext of [{ isMention: true }, { isReply: true }]) {
      const runtime = withRoomEntities(
        makeRuntime([
          stage1Response({
            thought: "Explicitly addressed turn.",
            contexts: ["simple"],
            replyText: "Here's my take.",
            addressedTo: ["Alice"],
          }),
        ]),
      );
      const result = await runStage1({
        runtime,
        message: makeMessage({
          text: "what do you think Alice should do here?",
          channelType: ChannelType.GROUP,
          mentionContext,
        }),
        responseId: "00000000-0000-0000-0000-0000000000b6" as UUID,
      });
      expect(result.kind).toBe("direct_reply");
    }
  });

  it("bypasses the gate when the effective personality reply_gate is an explicit 'always'", async () => {
    const runtime = withReplyGateSlots(
      withRoomEntities(
        makeRuntime([
          stage1Response({
            thought: "Chatty agent overhears.",
            contexts: ["simple"],
            replyText: "Jumping in anyway!",
            addressedTo: ["Alice"],
          }),
        ]),
      ),
      "always",
      "addressed_or_ambient",
    );
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "Alice, can you take a look?",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-0000000000b7" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("Jumping in anyway!");
    }
    const stage1Params = useModelCalls(runtime)[0]?.[1] as {
      messages?: Array<{ content?: string | null }>;
    };
    const stage1Content = (stage1Params.messages ?? [])
      .map((entry) => entry.content ?? "")
      .join("\n");
    expect(stage1Content).not.toContain("ambient_turn_policy:");
  });

  it("does not inject ambient policy for canonical or configured response bypasses", async () => {
    const cases = [
      {
        label: "scheduled trigger",
        content: {
          channelType: ChannelType.GROUP,
          source: "trigger-prompt",
        },
        settings: undefined,
      },
      {
        label: "configured source",
        content: {
          channelType: ChannelType.GROUP,
          source: "trusted_dispatch",
        },
        settings: { ALWAYS_RESPOND_SOURCES: "trusted_dispatch" },
      },
      {
        label: "configured channel",
        content: {
          channelType: ChannelType.GROUP,
          source: "test",
        },
        settings: { ALWAYS_RESPOND_CHANNELS: "group" },
      },
    ] satisfies Array<{
      label: string;
      content: Partial<Memory["content"]>;
      settings: Record<string, string> | undefined;
    }>;

    for (const testCase of cases) {
      const runtime = makeRuntime(
        [
          stage1Response({
            thought: "Bypass response.",
            contexts: ["simple"],
            replyText: "Delivered.",
          }),
        ],
        testCase.settings,
      );
      const result = await runStage1({
        runtime,
        message: makeMessage(testCase.content),
        responseId: "00000000-0000-0000-0000-0000000000bd" as UUID,
      });
      const params = useModelCalls(runtime)[0]?.[1] as {
        messages?: Array<{ content?: string | null }>;
      };
      const prompt = (params.messages ?? [])
        .map((entry) => entry.content ?? "")
        .join("\n");

      expect(result.kind, testCase.label).toBe("direct_reply");
      expect(prompt, testCase.label).not.toContain("ambient_turn_policy:");
    }
  });

  it("fails open without ambient silence when personality lookup throws", async () => {
    const runtime = makeRuntime([
      stage1Response({
        thought: "Personality state is unavailable.",
        contexts: ["simple"],
        replyText: "Still delivered.",
      }),
    ]);
    (runtime as unknown as Record<string, unknown>).getService = vi.fn(
      (type: string) =>
        type === "PERSONALITY_STORE"
          ? {
              getSlot: () => {
                throw new Error("personality store unavailable");
              },
            }
          : null,
    );

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "ambient group message",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-0000000000be" as UUID,
    });
    const params = useModelCalls(runtime)[0]?.[1] as {
      messages?: Array<{ content?: string | null }>;
    };
    const prompt = (params.messages ?? [])
      .map((entry) => entry.content ?? "")
      .join("\n");

    expect(result.kind).toBe("direct_reply");
    expect(prompt).not.toContain("ambient_turn_policy:");
    expect(reportErrorCalls(runtime)).toContainEqual([
      "MessageService.resolveAmbientReplyGate",
      expect.any(Error),
      expect.objectContaining({ roomId: expect.any(String) }),
    ]);
  });

  it("keeps the gate armed under reply_gate 'addressed_or_ambient' (only 'always' bypasses)", async () => {
    const runtime = withReplyGateMode(
      withRoomEntities(
        makeRuntime([
          stage1Response({
            thought: "Overheard.",
            contexts: ["simple"],
            replyText: "I could answer this.",
            addressedTo: ["Alice"],
          }),
        ]),
      ),
      "addressed_or_ambient",
    );
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "Alice, can you take a look?",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-0000000000b8" as UUID,
    });
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") {
      expect(result.action).toBe("IGNORE");
    }
  });

  it("fails open when addressee resolution errors — the turn proceeds unsuppressed (J4)", async () => {
    const runtime = makeRuntime([
      stage1Response({
        thought: "Room lookup breaks.",
        contexts: ["simple"],
        replyText: "Still here.",
        addressedTo: ["Alice"],
      }),
    ]);
    (runtime as unknown as Record<string, unknown>).getEntitiesForRoom = vi.fn(
      async () => {
        throw new Error("room lookup down");
      },
    );
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "Alice, can you take a look?",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-0000000000b9" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("Still here.");
    }
    const scopes = reportErrorCalls(runtime).map((call) => call[0]);
    expect(scopes).toContain("MessageService.resolveAddressees");
  });
});

import {
  buildStageChatMessages,
  type ContextEvent,
  type ContextObject,
  completionContextSources,
  type IAgentRuntime,
  type Memory,
  renderContextObject,
  type State,
  segmentBlock,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentTimeProvider } from "../../features/basic-capabilities/providers/currentTime.ts";
import { createV5MessageContextObject } from "./context-assembly.ts";
import { appendPriorDialogueEvents } from "./dialogue-context.ts";
import { sourceReplyTextHash } from "./source-reply-references.ts";
import { renderMessageHandlerModelInput } from "./stage1-input.ts";

const observed = Date.parse("2026-10-26T20:42:36.954Z");
const now = Date.parse("2026-10-27T02:57:00.000Z");
const body = "Moved the requested item to Trash.";
const runtime = {
  agentId: "agent",
  character: { name: "Eliza" },
  getSetting: () => null,
} as unknown as IAgentRuntime;
const current = {
  id: "current",
  agentId: "agent",
  roomId: "room",
  entityId: "user",
  createdAt: now,
  content: {
    text: "What records do I have?",
    source: "client_chat",
    channelType: "DM",
    metadata: { uiTimeZone: "America/Los_Angeles" },
  },
} as Memory;
function memory(at: number, id = "prior", text = body): Memory {
  return {
    id,
    agentId: "agent",
    roomId: "room",
    entityId: "agent",
    createdAt: at,
    content: { text, source: "client_chat", channelType: "DM" },
  } as Memory;
}
function context(
  messages: Memory[],
  zone: unknown = "America/Los_Angeles",
): ContextObject {
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    runtime,
    {
      values: {},
      data: {
        providers: {
          CURRENT_TIME: { data: { timeZone: zone } },
          RECENT_MESSAGES: { data: { recentMessages: messages } },
        },
      },
    } as State,
    current,
    { includeOwnReplies: true },
  );
  events.push({
    id: "current-turn",
    type: "message",
    createdAt: now,
    source: "client_chat",
    message: { id: current.id, role: "user", content: current.content },
  });
  return {
    id: "turn",
    version: "v5",
    metadata: { displayTimeZone: typeof zone === "string" ? zone : undefined },
    staticPrefix: {
      systemPrompt: {
        id: "system",
        label: "system",
        content: "Keep the existing source and approval rules.",
        stable: true,
      },
    },
    events,
  };
}
function stageOne(ctx: ContextObject, labels = false) {
  return renderMessageHandlerModelInput(
    { character: { name: "Eliza" } },
    ctx,
    [],
    {
      directMessage: true,
      nativeTools: true,
      completionContextSelection: labels,
    },
  ).messages;
}
function userWire(ctx: ContextObject, labels = false) {
  return stageOne(ctx, labels)
    .filter((m) => m.role === "user")
    .map((m) => String(m.content))
    .join("\n");
}
function block(
  at: unknown,
  zone: unknown = "America/Los_Angeles",
  label = "prior_message:agent",
) {
  return segmentBlock({
    id: "history:one",
    label,
    content: body,
    stable: false,
    createdAt: at as number,
    metadata: { displayTimeZone: zone as string },
  });
}

describe("historical message temporal grounding", () => {
  afterEach(() => vi.useRealTimers());
  it("distinguishes same text recorded today from the prior local day on the actual Stage1 native wire", () => {
    const today = context([memory(observed)]),
      yesterday = context([memory(observed - 86400000)]);
    expect(userWire(today)).toContain(
      "[message_at=2026-10-26T13:42:36.954-07:00]",
    );
    expect(userWire(yesterday)).toContain(
      "[message_at=2026-10-25T13:42:36.954-07:00]",
    );
    expect(userWire(today)).not.toEqual(userWire(yesterday));
    expect(stageOne(today)[0]).toEqual(stageOne(yesterday)[0]);
  });
  it("uses the already computed CURRENT_TIME view across UTC and sender-local date boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const clock = await currentTimeProvider.get(runtime, current, {} as State);
    expect(clock.values?.currentDate).toBe("2026-10-26");
    expect(clock.text).toContain("UTC instant: 2026-10-27T02:57:00.000Z");
    const events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      runtime,
      {
        values: {},
        data: {
          providers: {
            CURRENT_TIME: clock,
            RECENT_MESSAGES: { data: { recentMessages: [memory(observed)] } },
          },
        },
      } as State,
      current,
      { includeOwnReplies: true },
    );
    const assembled = await createV5MessageContextObject({
      runtime: {
        ...runtime,
        actions: [],
        providers: [currentTimeProvider],
        getService: () => null,
      } as unknown as IAgentRuntime,
      message: current,
      state: {
        values: {},
        data: {
          providers: {
            CURRENT_TIME: clock,
            RECENT_MESSAGES: { data: { recentMessages: [memory(observed)] } },
          },
        },
      } as State,
      selectedContexts: ["general"],
      includeTools: false,
      userRoles: ["OWNER"],
    });
    expect(assembled.metadata?.displayTimeZone).toBe("America/Los_Angeles");
    expect(userWire(assembled)).toContain("2026-10-26T13:42:36.954-07:00");
  });
  it("preserves raw originals, source IDs, exact text hashes and append-only events", () => {
    const ctx = context([memory(observed)]),
      before = structuredClone(ctx),
      sources = completionContextSources(ctx).sources;
    const rendered = renderContextObject(ctx),
      history = rendered.promptSegments.find((s) => s.id === "history:prior");
    if (!history) throw new Error("Expected prior history segment");
    expect(history.createdAt).toBe(observed);
    expect(history.content).toBe("Eliza: " + body);
    expect(sourceReplyTextHash(history.content)).toBe(
      sourceReplyTextHash("Eliza: " + body),
    );
    userWire(ctx, true);
    expect(ctx).toEqual(before);
    expect(completionContextSources(ctx).sources.map((s) => s.id)).toEqual(
      sources.map((s) => s.id),
    );
    expect(
      completionContextSources({
        ...ctx,
        metadata: { ...ctx.metadata, displayTimeZone: "UTC" },
      }).sourceSetId,
    ).toBe(completionContextSources(ctx).sourceSetId);
  });
  it("retains each occurrence time through same-text reference encoding", () => {
    const text = "Complete synthetic original. ".repeat(100),
      ctx = context([
        memory(observed - 86400000, "old", text),
        memory(observed, "new", text),
      ]);
    const wire = userWire(ctx, true);
    expect(wire).toContain("same_text_as=");
    expect(wire).toContain("2026-10-25T13:42:36.954-07:00");
    expect(wire).toContain("2026-10-26T13:42:36.954-07:00");
  });
  it("preserves distinct offsets during a repeated DST hour without relative-date guesses", () => {
    expect(block(Date.parse("2026-11-01T08:30:00Z"))).toContain(
      "2026-11-01T01:30:00.000-07:00",
    );
    expect(block(Date.parse("2026-11-01T09:30:00Z"))).toContain(
      "2026-11-01T01:30:00.000-08:00",
    );
  });
  it.each([undefined, 0, -1, NaN, Infinity, 8.64e15 + 1, "2026-10-26"])(
    "does not invent a date for missing/invalid recorded time %s",
    (at) => {
      expect(block(at)).toBe(body);
    },
  );
  it("uses the known UTC instant if the display zone is missing or invalid, without echoing it", () => {
    expect(
      segmentBlock({
        label: "prior_message:agent",
        content: body,
        stable: false,
        createdAt: observed,
      }),
    ).toContain("2026-10-26T20:42:36.954Z");
    expect(block(observed, "invalid-zone-value")).toBe(
      "[message_at=2026-10-26T20:42:36.954Z] " + body,
    );
  });
  it("does not duplicate clock facts or annotate providers, instructions or current user messages", () => {
    expect(
      block(observed, "America/Los_Angeles", "provider:CURRENT_TIME"),
    ).toBe(body);
    expect(block(observed, "America/Los_Angeles", "system")).toBe(body);
    expect(block(observed, "America/Los_Angeles", "message:user")).toBe(
      "# Current message\n" + body,
    );
  });
  it("keeps the existing fallback for a malformed nonstring runtime label", () => {
    expect(block(observed, "America/Los_Angeles", 7 as unknown as string)).toBe(
      body,
    );
  });
  it("leaves nonhistorical segment projections byte- and identity-exact", () => {
    const segment = {
      id: "other",
      label: "provider:other",
      content: body,
      stable: true,
    };
    const result = renderContextObject({
      id: "turn",
      version: "v5",
      events: [{ id: "other", type: "segment", createdAt: observed, segment }],
    });
    expect(result.promptSegments[0]).toBe(segment);
    expect(segment).not.toHaveProperty("createdAt");
  });
  it("the source event instant wins over an inner segment timestamp without rewriting either source", () => {
    const event = {
      id: "history:one",
      type: "segment",
      source: "prior-dialogue",
      createdAt: observed,
      segment: {
        id: "history:one",
        label: "prior_message:agent",
        content: body,
        stable: false,
        createdAt: observed - 86400000,
        metadata: { displayTimeZone: "America/Los_Angeles" },
      },
    } as ContextEvent;
    const original = structuredClone(event),
      rendered = renderContextObject({
        id: "turn",
        version: "v5",
        events: [event],
      });
    expect(segmentBlock(rendered.promptSegments[0])).toContain(
      "2026-10-26T13:42:36.954-07:00",
    );
    expect(event).toEqual(original);
  });
  it("planning/evaluation use the same timestamp while stable cache-prefix bytes stay unchanged", () => {
    const wire = (at: number) =>
      buildStageChatMessages({
        contextSegments: renderContextObject(context([memory(at)]))
          .promptSegments,
        stageLabel: "planner",
        instructions: "Existing task",
        dynamicBlocks: [],
        stepMessages: [],
      });
    expect(wire(observed)[0]).toEqual(wire(observed - 86400000)[0]);
    expect(wire(observed)[1].content).toContain(
      "2026-10-26T13:42:36.954-07:00",
    );
  });
  it("does not convert a message timestamp into a contained operation timestamp or grant new scope", () => {
    const text =
      "Historical operation committedAt: 2026-10-24T10:00:00Z; this message is a later recap.";
    const wire = userWire(context([memory(observed, "recap", text)]));
    expect(wire).toContain("[message_at=2026-10-26T13:42:36.954-07:00]");
    expect(wire).toContain(text);
    expect(wire).not.toContain("deleted_at=");
  });
  it("unapproved cross-room originals stay excluded even when their timestamp is known", () => {
    const events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      runtime,
      {
        values: {},
        data: {
          providers: {
            CURRENT_TIME: { data: { timeZone: "America/Los_Angeles" } },
            RECENT_MESSAGES: {
              data: {
                recentMessages: [],
                recentInteractions: [{ ...memory(observed), roomId: "other" }],
              },
            },
          },
        },
      } as State,
      current,
      { includeOwnReplies: true },
    );
    expect(
      events.filter((e) => e.source === "verified-cross-room-context"),
    ).toHaveLength(0);
  });
});

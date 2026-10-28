/** Verifies persisted quote links load only unchanged authorized earlier originals. */
import {
  type ContextEvent,
  completionContextSources,
  createContextObject,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
} from "../../runtime/history-retention.ts";
import { appendPriorDialogueEvents } from "./dialogue-context";
import {
  type HistoryDiscovery,
  loadHistoryReferences,
  projectReviewedHistory,
  requestedHistory,
} from "./history-discovery";
import { createV5ReplyStrategyResult } from "./reply-policy";
import {
  createSourceReplySnapshot,
  resolveLiteralSourceReply,
  resolveSourceReply,
  type SourceReplyRendering,
} from "./source-reply";
import {
  readSourceReplyReferences,
  type SourceReplyReferences,
  sourceReplyEventHash,
  sourceReplyTextHash,
} from "./source-reply-references";

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing test value");
  return value;
}

function fixture(originalAttachments?: Memory["content"]["attachments"]) {
  const runtime = {
    agentId: "agent",
    character: { name: "Eliza" },
  } as IAgentRuntime;
  const original = {
    id: "original",
    roomId: "room",
    agentId: "agent",
    entityId: "user",
    createdAt: 1,
    content: {
      text: "The bag is orange.\nKeep  two spaces.",
      senderName: "Nubs",
      attachments: originalAttachments,
    },
  } as Memory;
  const message = {
    id: "question",
    roomId: "room",
    entityId: "user",
    content: { text: "Quote my original." },
  } as Memory;
  function contextFor(memories: Memory[]) {
    const events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      runtime,
      {
        data: {
          providers: {
            RECENT_MESSAGES: { data: { recentMessages: memories } },
          },
        },
      } as State,
      message,
      { includeOwnReplies: true },
    );
    return createContextObject({
      id: "turn",
      metadata: { roomId: "room", messageId: message.id },
      events,
    });
  }
  const context = contextFor([original]);
  const projection: HistoryDiscovery = {
    sourceSetId: completionContextSources(context).sourceSetId,
    scope: { agentId: "agent", roomId: "room", entityId: "user", roles: [] },
    visibleEventIds: new Set(),
    loadedSourceIds: new Set(["h1"]),
  };
  const snapshot = createSourceReplySnapshot(context, projection, [original]);
  if (!snapshot) throw Error("snapshot");
  let rendering: SourceReplyRendering | undefined;
  let references: SourceReplyReferences | undefined;
  const resolved = resolveSourceReply(
    context,
    snapshot,
    {
      replyText: [
        { kind: "text", value: "Your original:\n" },
        { kind: "source", value: "h1" },
      ],
      completionContext: {
        mode: "relevant_prior_dialogue",
        complete: true,
        sourceSetId: projection.sourceSetId,
        relevantSourceIds: ["h1"],
        constraintSourceIds: [],
        referentSourceIds: [],
        pendingIntentSourceIds: [],
      },
    },
    (value) => {
      rendering = value;
      references = value.references
        ? {
            replySha256: value.references.replySha256,
            sources: [...value.references.sources],
          }
        : undefined;
    },
  );
  if (typeof resolved?.replyText !== "string" || !references || !rendering)
    throw Error("reply");
  const result = createV5ReplyStrategyResult({
    runtime,
    message,
    state: {} as State,
    responseId: "reply" as Memory["id"] & string,
    text: resolved.replyText,
    thought: "",
    sourceReplyRendering: rendering,
  });
  // Roundtrip through the canonical serialized memory shape, not a private map.
  const reply = JSON.parse(
    JSON.stringify(result.responseMessages[0]),
  ) as Memory;
  reply.createdAt = 2;
  return {
    original,
    reply,
    message,
    runtime,
    references,
    rendering,
    contextFor,
    context,
    snapshot,
  };
}

describe("stored source-backed reply references", () => {
  it("rejects the captured array-as-string at the native parts boundary and preserves typed literal prose", () => {
    const f = fixture();
    // Preserved tj-f40b258a422066: HANDLE_RESPONSE advertised an array but stored this malformed string.
    const captured = '[{"kind": "text", "value": "Hey, I\'m here."}';
    const raw = { replyText: captured };
    expect(() =>
      resolveLiteralSourceReply(f.context, f.snapshot, raw),
    ).toThrowError(
      expect.objectContaining({ code: "STAGE1_INVALID_SOURCE_REPLY" }),
    );
    expect(raw.replyText).toBe(captured);
    const valid = { replyText: [{ kind: "text", value: "Hey, I'm here." }] };
    expect(
      resolveLiteralSourceReply(f.context, f.snapshot, valid)?.replyText,
    ).toBe("Hey, I'm here.");
    // The same bytes deliberately supplied as a text part are prose, never parsed or stripped.
    expect(
      resolveLiteralSourceReply(f.context, f.snapshot, {
        replyText: [{ kind: "text", value: captured }],
      })?.replyText,
    ).toBe(captured);
    expect(resolveSourceReply(f.context, f.snapshot, raw)).toBe(raw);
  });
  it("keeps omitted, empty, and ordinary string replyText on the existing path", () => {
    const f = fixture();
    for (const raw of [
      { shouldRespond: "IGNORE" },
      { shouldRespond: "STOP", replyText: "" },
      { shouldRespond: "RESPOND", replyText: "Hey, I'm here." },
      { shouldRespond: "RESPOND", replyText: "[draft] see the {notes}" },
    ])
      expect(resolveLiteralSourceReply(f.context, f.snapshot, raw)).toBe(raw);
  });
  it("supplies a recent quote's deferred original before the first decision", () => {
    const f = fixture();
    f.reply.createdAt = 20;
    const fillers = Array.from({ length: 12 }, (_, i) => ({
      ...f.original,
      id: `filler-${i}`,
      entityId: i % 2 === 0 ? "agent" : "user",
      createdAt: i + 2,
      content: { text: `Unrelated exchange ${i}` },
    })) as Memory[];
    const context = f.contextFor([f.original, ...fillers, f.reply]);
    const scope = {
      agentId: "agent",
      roomId: "room",
      entityId: "user",
      roles: [],
    };
    const prepared = prepareHistoryRetention(
      context,
      scope,
      null,
      "review",
      14,
    );
    const checkpoint = applyHistoryRetentionReview(prepared, {
      sourceSetId: prepared.sourceSetId,
      complete: true,
      retainSourceIds: ["h14"],
      deferSourceIds: completionContextSources(context)
        .sources.filter((s) => s.id !== "h14")
        .map((s) => s.id),
      uncertainSourceIds: [],
      dependencyGroups: [],
    });
    const projection = must(projectReviewedHistory(context, scope, checkpoint));
    expect(projection.visibleEventIds.has("history:original")).toBe(false);
    expect(projection.visibleEventIds.has("history:reply")).toBe(true);
    expect([...projection.loadedSourceIds]).toEqual(["h1"]);
  });
  it("loads an exact unpunctuated quote's original in the same authorized read", () => {
    const f = fixture();
    expect(f.reply.content.text).toContain(f.original.content.text);
    const context = f.contextFor([f.original, f.reply]);
    const projection: HistoryDiscovery = {
      sourceSetId: completionContextSources(context).sourceSetId,
      scope: { agentId: "agent", roomId: "room", entityId: "user", roles: [] },
      visibleEventIds: new Set(),
      loadedSourceIds: new Set(),
    };
    const read = loadHistoryReferences(context, projection, [
      "history:search:Your original",
    ]);
    expect([...must(read.projection).loadedSourceIds]).toEqual(["h2", "h1"]);
    expect(must(must(read.evidence).searchResults)[0].matchedSourceIds).toEqual(
      ["h2"],
    );
    expect(
      requestedHistory(
        context,
        read.projection,
        {
          completionContext: {
            mode: "relevant_prior_dialogue",
            complete: true,
            sourceSetId: projection.sourceSetId,
            relevantSourceIds: ["h2"],
            constraintSourceIds: [],
            referentSourceIds: [],
            pendingIntentSourceIds: [],
          },
        },
        [],
      ),
    ).toEqual([]);
  });
  it.each([
    "edited-original",
    "deleted-original",
    "changed-owner",
    "changed-room",
    "rewritten-reply",
    "tampered-hash",
    "user-copy",
    "later-original",
  ])("does not follow %s", (mode) => {
    const f = fixture();
    if (mode === "edited-original") f.original.content.text += " Correction.";
    if (mode === "changed-owner")
      f.original.entityId = "other" as Memory["entityId"];
    if (mode === "changed-room")
      f.original.roomId = "other" as Memory["roomId"];
    if (mode === "rewritten-reply") f.reply.content.text += " Added prose.";
    if (mode === "tampered-hash")
      must(f.reply.content.sourceReplyReferences).sources[0].sourceSha256 =
        "0".repeat(64);
    if (mode === "user-copy") f.reply.entityId = "user" as Memory["entityId"];
    if (mode === "later-original") f.original.createdAt = 3;
    const context = f.contextFor(
      mode === "deleted-original" ? [f.reply] : [f.original, f.reply],
    );
    const sources = completionContextSources(context);
    const replyId = must(
      sources.sources.find((s) => s.event.id === "history:reply"),
    ).id;
    const projection: HistoryDiscovery = {
      sourceSetId: sources.sourceSetId,
      scope: { agentId: "agent", roomId: "room", entityId: "user", roles: [] },
      visibleEventIds: new Set(),
      loadedSourceIds: new Set(),
    };
    expect([
      ...must(
        loadHistoryReferences(context, projection, [`history:${replyId}`])
          .projection,
      ).loadedSourceIds,
    ]).toEqual([replyId]);
  });
  it("follows a reply's stored quote link when the reply carries an attachment", () => {
    const f = fixture();
    f.reply.content.attachments = [
      {
        id: "bag-photo",
        url: "https://example.com/bag.png",
        title: "bag.png",
        contentType: "image/png",
        description: "An orange bag on a table.",
      },
    ] as Memory["content"]["attachments"];
    const context = f.contextFor([f.original, f.reply]);
    const sources = completionContextSources(context);
    const reply = must(
      sources.sources.find((s) => s.event.id === "history:reply"),
    );
    const original = must(
      sources.sources.find((s) => s.event.id === "history:original"),
    );
    expect(reply.event.segment.content).toContain(
      "[attachment: bag.png; image/png; An orange bag on a table.]",
    );
    const projection: HistoryDiscovery = {
      sourceSetId: sources.sourceSetId,
      scope: { agentId: "agent", roomId: "room" },
      visibleEventIds: new Set(),
      loadedSourceIds: new Set(),
    };
    expect([
      ...must(
        loadHistoryReferences(context, projection, [`history:${reply.id}`])
          .projection,
      ).loadedSourceIds,
    ]).toEqual([reply.id, original.id]);
  });
  it("finds a quoted original that carries an attachment", () => {
    const f = fixture([
      {
        id: "bag-photo",
        url: "https://example.com/bag.png",
        title: "bag.png",
        contentType: "image/png",
        description: "An orange bag on a table.",
      },
    ] as Memory["content"]["attachments"]);
    const context = f.contextFor([f.original, f.reply]);
    const sources = completionContextSources(context);
    const [original, reply] = sources.sources;
    expect(original.event.segment.content).toBe(
      "Nubs: The bag is orange.\nKeep  two spaces. [attachment: bag.png; image/png; An orange bag on a table.]",
    );
    const projection: HistoryDiscovery = {
      sourceSetId: sources.sourceSetId,
      scope: { agentId: "agent", roomId: "room" },
      visibleEventIds: new Set([reply.event.id]),
      loadedSourceIds: new Set(),
    };
    // The stored quote link of the reply.
    expect([
      ...must(
        loadHistoryReferences(context, projection, [`history:${reply.id}`])
          .projection,
      ).loadedSourceIds,
    ]).toEqual([reply.id, original.id]);
    // A literal quote in a new draft.
    expect(
      requestedHistory(
        context,
        projection,
        {
          replyText: `You said "${f.original.content.text}"`,
          completionContext: {
            mode: "selected",
            complete: true,
            sourceSetId: sources.sourceSetId,
            relevantSourceIds: [],
            constraintSourceIds: [],
            referentSourceIds: [],
            pendingIntentSourceIds: [],
          },
        },
        [],
      ),
    ).toEqual([`history:${original.id}`]);
  });
  it("follows an earlier quote chain once without relabeling its speakers", () => {
    const f = fixture();
    const first = completionContextSources(f.contextFor([f.original, f.reply]));
    const priorReply = must(
      first.sources.find((s) => s.event.id === "history:reply"),
    );
    const text = `Quoted answer:\n${f.reply.content.text}`;
    const next = {
      ...f.reply,
      id: "next",
      createdAt: 3,
      content: {
        text,
        sourceReplyReferences: {
          replySha256: sourceReplyTextHash(text),
          sources: [
            {
              eventId: priorReply.event.id,
              sourceSha256: sourceReplyEventHash(priorReply.event),
            },
          ],
        },
      },
    } as Memory;
    const context = f.contextFor([f.original, f.reply, next]);
    const bound = completionContextSources(context);
    const projection: HistoryDiscovery = {
      sourceSetId: bound.sourceSetId,
      scope: { agentId: "agent", roomId: "room", entityId: "user", roles: [] },
      visibleEventIds: new Set(),
      loadedSourceIds: new Set(),
    };
    expect([
      ...must(
        loadHistoryReferences(context, projection, ["history:h3"]).projection,
      ).loadedSourceIds,
    ]).toEqual(["h3", "h1", "h2"]);
    expect(bound.sources.map((s) => s.event.segment.label)).toEqual([
      "prior_message:user",
      "prior_message:agent",
      "prior_message:agent",
    ]);
  });
  it("drops references after final text changes and rejects malformed metadata", () => {
    const f = fixture();
    const result = createV5ReplyStrategyResult({
      runtime: f.runtime,
      message: f.message,
      state: {} as State,
      responseId: must(f.reply.id),
      text: "A rewritten answer.",
      thought: "",
      sourceReplyRendering: f.rendering,
    });
    expect(result.responseContent.sourceReplyReferences).toBeUndefined();
    expect(
      readSourceReplyReferences(
        {
          ...f.references,
          sources: [{ eventId: "outside", sourceSha256: "bad" }],
        },
        must(f.reply.content.text),
      ),
    ).toBeUndefined();
  });
});

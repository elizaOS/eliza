/** Validates native original-message rendering, binding and routing boundaries. */
import {
  type ContextObject,
  completionContextSources,
  type Memory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { renderProviderOriginalMessages } from "../../runtime/provider-originals.ts";
import type { HistoryDiscovery } from "./history-discovery";
import { replyClaimsCompletedSideEffect } from "./side-effect-claims.ts";
import {
  bindSourceReplyContent,
  createSourceReplySnapshot,
  getSourceReplyBinding,
  resolveLiteralSourceReply,
  resolveSourceReply,
  type SourceReplyRendering,
  sourceReplyAssertionText,
} from "./source-reply";
import { sourceReplyTextHash } from "./source-reply-references.ts";
import {
  getStage1RoutingRepair,
  getStage1UnusableDecisionRepair,
} from "./stage1-generation";

function fixture() {
  const sourceText = "  Mira’s bag is orange.\nKeep  two spaces.\n";
  const memory = {
    id: "source",
    roomId: "room",
    entityId: "user",
    agentId: "agent",
    content: { text: sourceText },
  } as Memory;
  const context: ContextObject = {
    id: "turn",
    metadata: { roomId: "room", messageId: "turn" },
    staticPrefix: { systemPrompt: { content: "Eliza", stable: true } },
    events: [
      {
        id: "history:source",
        type: "segment",
        source: "prior-dialogue",
        segment: {
          id: "history:source",
          label: "prior_message:user",
          content: `Nubs: ${memory.content.text?.trim()}`,
          stable: false,
          metadata: {
            roomId: "room",
            entityId: "user",
            speakerName: "Nubs",
            originalTextSha256: sourceReplyTextHash(sourceText),
          },
        },
      },
    ],
  };
  const sourceSetId = completionContextSources(context).sourceSetId;
  const projection: HistoryDiscovery = {
    sourceSetId,
    scope: {
      agentId: "agent",
      roomId: "room",
      entityId: "user",
      roles: ["OWNER"],
    },
    visibleEventIds: new Set(),
    loadedSourceIds: new Set(["h1"]),
  };
  const snapshot = createSourceReplySnapshot(context, projection, [memory]);
  if (!snapshot) throw new Error("missing snapshot");
  const raw = {
    shouldRespond: "RESPOND",
    contexts: ["simple"],
    intents: [],
    candidateActionNames: [],
    contextRequests: [],
    replyEffectStatus: "none",
    replyText: [
      { kind: "text", value: "You said:\n" },
      { kind: "source", value: "h1" },
    ],
    completionContext: {
      mode: "relevant_prior_dialogue",
      complete: true,
      sourceSetId,
      relevantSourceIds: ["h1"],
      constraintSourceIds: [],
      referentSourceIds: [],
      pendingIntentSourceIds: [],
    },
  };
  return { memory, context, projection, snapshot, raw };
}
describe("literal source replies without model-facing source IDs", () => {
  it("validates exact original bytes without selecting planner history", () => {
    const f = fixture();
    const raw = {
      replyText: [{ kind: "source", value: f.memory.content.text }],
    };
    let rendering: SourceReplyRendering | undefined;
    const resolved = resolveLiteralSourceReply(
      f.context,
      f.snapshot,
      raw,
      (value) => {
        rendering = value;
      },
    );
    expect(resolved).toEqual({ replyText: f.memory.content.text });
    expect(rendering?.references?.sources[0].eventId).toBe("history:source");
    expect(raw.replyText[0].value).toBe(f.memory.content.text);
  });
  it("never exempts ordinary strings or text parts from assertion checks", () => {
    const f = fixture();
    const raw = { replyText: f.memory.content.text };
    let rendering: SourceReplyRendering | undefined;
    expect(
      resolveLiteralSourceReply(f.context, f.snapshot, raw, (value) => {
        rendering = value;
      }),
    ).toBe(raw);
    expect(rendering).toBeUndefined();
    resolveLiteralSourceReply(
      f.context,
      f.snapshot,
      { replyText: [{ kind: "text", value: "Saved it." }] },
      (value) => {
        rendering = value;
      },
    );
    expect(rendering).toBeUndefined();
  });
  it("rejects invented or altered originals before reply processing", () => {
    const f = fixture();
    expect(() =>
      resolveLiteralSourceReply(f.context, f.snapshot, {
        replyText: [{ kind: "source", value: f.memory.content.text?.trim() }],
      }),
    ).toThrow("Quoted text does not match a supplied original");
  });
  it("does not reuse a snapshot after the context changes", () => {
    const f = fixture();
    f.context.events = [];
    expect(
      resolveLiteralSourceReply(f.context, f.snapshot, {
        replyText: [{ kind: "source", value: f.memory.content.text }],
      }),
    ).toBeUndefined();
  });
});

describe("source-backed native replies", () => {
  it("separates typed source blocks without weakening mixed-claim checks", () => {
    const f = fixture();
    f.memory.content.text = "the note.";
    const event = f.context.events[0];
    if (event.type !== "segment" || !("segment" in event))
      throw Error("source expected");
    event.segment.content = "Nubs: the note.";
    event.segment.metadata = {
      ...event.segment.metadata,
      originalTextSha256: sourceReplyTextHash("the note."),
    };
    f.projection.sourceSetId = completionContextSources(f.context).sourceSetId;
    const snapshot = createSourceReplySnapshot(f.context, f.projection, [
      f.memory,
    ]);
    if (!snapshot) throw Error("snapshot expected");
    let rendering: SourceReplyRendering | undefined;
    const result = resolveSourceReply(
      f.context,
      snapshot,
      {
        ...f.raw,
        completionContext: {
          ...f.raw.completionContext,
          sourceSetId: f.projection.sourceSetId,
        },
        replyText: [
          { kind: "text", value: "Created " },
          { kind: "source", value: "h1" },
        ],
      },
      (value) => {
        rendering = value;
      },
    );
    expect(result?.replyText).toBe("Created \n\nthe note.");
    if (!rendering) throw Error("rendering expected");
    expect(
      replyClaimsCompletedSideEffect(sourceReplyAssertionText(rendering)),
    ).toBe(true);
  });

  it("combines history and provider originals without storing a cross-room history link", () => {
    const f = fixture();
    const originalMessages = {
      header: "Relevant past conversations:",
      sources: [
        {
          id: "recalled1",
          prefix: "[chat] Other author: ",
          originalText: "Provider original",
          memoryId: "other",
          agentId: "agent",
          roomId: "other-room",
          entityId: "other-author",
          createdAt: 1,
        },
      ],
    };
    f.context.events.push({
      id: "provider:recall",
      type: "provider",
      name: "recall",
      text: renderProviderOriginalMessages(originalMessages),
      data: { originalMessages },
    });
    f.projection.sourceSetId = completionContextSources(f.context).sourceSetId;
    const snapshot = createSourceReplySnapshot(f.context, f.projection, [
      f.memory,
    ]);
    if (!snapshot) throw Error("snapshot missing");
    let rendering: SourceReplyRendering | undefined;
    const result = resolveSourceReply(
      f.context,
      snapshot,
      {
        ...f.raw,
        completionContext: {
          ...f.raw.completionContext,
          sourceSetId: f.projection.sourceSetId,
        },
        replyText: [
          { kind: "source", value: "h1" },
          { kind: "text", value: "\n\n" },
          { kind: "source", value: "recalled1" },
        ],
      },
      (value) => {
        rendering = value;
      },
    );
    expect(result?.replyText).toBe(
      `${f.memory.content.text}\n\nProvider original`,
    );
    expect(
      rendering?.references?.sources.map((source) => source.eventId),
    ).toEqual(["history:source"]);
  });

  it("exempts only one complete literal from newly authored claim checks", () => {
    const f = fixture();
    const render = (replyText: { kind: string; value: string }[]) => {
      let rendering: SourceReplyRendering | undefined;
      resolveSourceReply(
        f.context,
        f.snapshot,
        { ...f.raw, replyText },
        (value) => {
          rendering = value;
        },
      );
      if (!rendering) throw Error("missing rendering");
      return rendering;
    };
    const single = render([{ kind: "source", value: "h1" }]);
    expect(sourceReplyAssertionText(single)).toBe("");
    const mixed = render([
      { kind: "text", value: "Created " },
      { kind: "source", value: "h1" },
    ]);
    expect(sourceReplyAssertionText(mixed)).toBe(mixed.text);
    const combined = render([
      { kind: "source", value: "h1" },
      { kind: "source", value: "h1" },
    ]);
    expect(sourceReplyAssertionText(combined)).toBe(combined.text);
    const content = bindSourceReplyContent(
      { text: single.text },
      single,
      single.scope,
    );
    expect(getSourceReplyBinding(content, single.scope)).toBe(single);
    expect(
      getSourceReplyBinding(JSON.parse(JSON.stringify(content)), single.scope),
    ).toBeUndefined();
    expect(
      getSourceReplyBinding(content, { ...single.scope, messageId: "another" }),
    ).toBeUndefined();
    expect(
      getSourceReplyBinding({ ...content, text: "changed" }, single.scope),
    ).toBeUndefined();
  });

  it("preserves original bytes, raw model output and current routing guards", () => {
    const { memory, context, snapshot, raw } = fixture();
    const before = JSON.stringify({ context, raw });
    const r = resolveSourceReply(context, snapshot, raw);
    expect(r?.replyText).toBe(`You said:\n${memory.content.text}`);
    expect(JSON.stringify({ context, raw })).toBe(before);
    expect(getStage1UnusableDecisionRepair(r ?? null)).toBeUndefined();
    expect(
      getStage1RoutingRepair({ ...r, intents: ["Create a note"] }),
    ).toBeDefined();
    memory.content.text = "later mutation";
    expect(resolveSourceReply(context, snapshot, raw)?.replyText).not.toContain(
      "later mutation",
    );
  });
  it.each(["turn", "source", "speaker", "room"])(
    "rejects stale %s binding",
    (mode) => {
      const { context, snapshot, raw } = fixture();
      if (mode === "turn") context.id = "changed";
      else if (mode === "room") context.metadata = { roomId: "other" };
      else {
        const e = context.events[0];
        if (e.type !== "segment") throw Error();
        if (mode === "source") e.segment.content += "changed";
        else e.segment.metadata = { entityId: "other" };
      }
      expect(resolveSourceReply(context, snapshot, raw)).toBeUndefined();
    },
  );
  it.each(["agent", "owner", "room", "body", "duplicate", "envelope"])(
    "does not resolve unmatched %s records",
    (mode) => {
      const f = fixture();
      const m = structuredClone(f.memory);
      if (mode === "agent") m.agentId = "other" as Memory["agentId"];
      if (mode === "owner") m.entityId = "other" as Memory["entityId"];
      if (mode === "room") m.roomId = "other" as Memory["roomId"];
      if (mode === "body") m.content.text = "different";
      if (mode === "envelope")
        m.content.text += "\n[language instruction: Reply in English]";
      const s = createSourceReplySnapshot(
        f.context,
        f.projection,
        mode === "duplicate" ? [m, m] : [m],
      );
      expect(s?.originals.size).toBe(0);
      if (!s) throw Error();
      expect(() => resolveSourceReply(f.context, s, f.raw)).toThrow();
    },
  );
  it("supports complete supplied history without a retention projection", () => {
    const f = fixture();
    const snapshot = createSourceReplySnapshot(
      f.context,
      { scope: f.projection.scope },
      [f.memory],
    );
    if (!snapshot) throw Error("snapshot");
    expect(resolveSourceReply(f.context, snapshot, f.raw)?.replyText).toContain(
      f.memory.content.text,
    );
    expect(
      resolveSourceReply(f.context, snapshot, {
        ...f.raw,
        replyText: "Ordinary h1 text",
      })?.replyText,
    ).toBe("Ordinary h1 text");
  });
  it("keeps unavailable selections in history recovery", () => {
    const f = fixture();
    expect(
      resolveSourceReply(
        f.context,
        { ...f.snapshot, suppliedIds: new Set() },
        f.raw,
      ),
    ).toBeUndefined();
  });
  it.each([
    null,
    [{ kind: "source", value: "h99" }],
    [{ kind: "text", value: 1 }],
    [{ kind: "source", value: "h1", extra: true }],
    [{ kind: "other", value: "h1" }],
  ])("rejects malformed parts %j", (parts) => {
    const f = fixture();
    expect(() =>
      resolveSourceReply(f.context, f.snapshot, { ...f.raw, replyText: parts }),
    ).toThrow();
  });
  it("allows no-reply and ordinary text without interpreting source-looking markers", () => {
    const f = fixture();
    expect(
      resolveSourceReply(f.context, f.snapshot, { ...f.raw, replyText: [] })
        ?.replyText,
    ).toBe("");
    expect(
      resolveSourceReply(f.context, f.snapshot, {
        ...f.raw,
        replyText: [{ kind: "text", value: "[source:h1]" }],
      })?.replyText,
    ).toBe("[source:h1]");
  });
  it("does not strip a literal speaker prefix", () => {
    const f = fixture();
    f.memory.content.text = "Nubs: This prefix is part of my message.";
    const e = f.context.events[0];
    if (e.type !== "segment") throw Error();
    e.segment.content = f.memory.content.text;
    e.segment.metadata = {
      ...e.segment.metadata,
      originalTextSha256: sourceReplyTextHash(f.memory.content.text),
    };
    f.projection.sourceSetId = completionContextSources(f.context).sourceSetId;
    f.raw.completionContext.sourceSetId = f.projection.sourceSetId;
    const s = createSourceReplySnapshot(f.context, f.projection, [f.memory]);
    if (!s) throw Error();
    expect(resolveSourceReply(f.context, s, f.raw)?.replyText).toBe(
      "You said:\nNubs: This prefix is part of my message.",
    );
  });
});

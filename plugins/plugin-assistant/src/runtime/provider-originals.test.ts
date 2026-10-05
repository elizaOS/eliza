/** Provider originals must match the authorized supplied text, not hidden metadata. */
import type { ContextEvent, ContextObject, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { appendStateProviderEvents } from "../services/message/dialogue-context.ts";
import {
  createSourceReplySnapshot,
  resolveSourceReply,
  type SourceReplyRendering,
} from "../services/message/source-reply.ts";
import {
  type ProviderOriginalMessages,
  providerOriginals,
  readProviderOriginalMessages,
  renderProviderOriginalMessages,
} from "./provider-originals.ts";

function fixture() {
  const data = {
    header:
      "Relevant past conversations (partial; some matching messages were withheld by access policy):",
    sources: [
      {
        id: "recalled1",
        prefix: "[chat] Yesterday Nubs: ",
        originalText: "  Keep my original  spacing.\n",
        memoryId: "original",
        agentId: "agent",
        roomId: "earlier-room",
        entityId: "user",
        createdAt: 1,
      },
    ],
  } satisfies ProviderOriginalMessages;
  const events: ContextEvent[] = [];
  const state: State = {
    text: "",
    values: {},
    data: {
      providers: {
        "relevant-conversations": {
          text: renderProviderOriginalMessages(data),
          data: { originalMessages: data },
        },
      },
    },
  };
  appendStateProviderEvents(events, state);
  const context: ContextObject = {
    id: "turn",
    metadata: { roomId: "room", messageId: "question" },
    events,
  };
  const snapshot = createSourceReplySnapshot(
    context,
    {
      scope: { agentId: "agent", roomId: "room", entityId: "user", roles: [] },
    },
    [],
  );
  if (!snapshot) throw Error("Missing snapshot");
  const raw = {
    replyText: [{ kind: "source", value: "recalled1" }],
    completionContext: { mode: "full", complete: false, sourceSetId: "" },
  };
  return { data, state, context, snapshot, raw };
}

describe("provider-original replies", () => {
  it("quotes a supplied provider original without inventing current-room history", () => {
    const f = fixture();
    let rendering: SourceReplyRendering | undefined;
    const reply = resolveSourceReply(f.context, f.snapshot, f.raw, (value) => {
      rendering = value;
    });
    expect(reply?.replyText).toBe(f.data.sources[0].originalText);
    expect(rendering?.references).toBeUndefined();
    expect(f.snapshot.suppliedIds.size).toBe(0);
    expect(renderProviderOriginalMessages(f.data)).toContain(
      "partial; some matching messages were withheld",
    );
  });
  it.each([
    "redacted",
    "discovery",
    "deleted",
    "renamed",
    "reordered",
    "turn",
    "author",
    "room",
    "body",
  ])("rejects changed %s sources", (change) => {
    const f = fixture();
    const event = f.context.events[0];
    if (event.type !== "provider" || !("name" in event))
      throw Error("provider expected");
    if (change === "redacted")
      event.text = "Relevant past conversations: [REDACTED]";
    if (change === "discovery")
      event.text = "Read relevant-conversations for originals.";
    if (change === "deleted") f.context.events = [];
    if (change === "renamed") event.name = "another-provider";
    if (change === "reordered")
      f.context.events.unshift({
        id: "other",
        type: "instruction",
        content: "Keep all constraints.",
      });
    if (change === "turn")
      f.context.metadata = { ...f.context.metadata, messageId: "another-turn" };
    if (["author", "room", "body"].includes(change)) {
      const altered = structuredClone(f.data);
      if (change === "author") altered.sources[0].entityId = "someone-else";
      if (change === "room") altered.sources[0].roomId = "another-room";
      if (change === "body") altered.sources[0].originalText = "changed body";
      event.data = { originalMessages: altered };
      event.text = renderProviderOriginalMessages(altered).trim();
    }
    expect(resolveSourceReply(f.context, f.snapshot, f.raw)).toBeUndefined();
  });
  it("does not propagate metadata for text redacted before context assembly", () => {
    const f = fixture();
    const events: ContextEvent[] = [];
    appendStateProviderEvents(events, {
      text: "",
      values: {},
      data: {
        providers: {
          "relevant-conversations": {
            text: "Redacted",
            data: { originalMessages: f.data },
          },
        },
      },
    });
    expect(providerOriginals({ ...f.context, events })).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain(
      f.data.sources[0].originalText.trim(),
    );
  });
  it("rejects duplicate or history-shaped provider IDs", () => {
    const f = fixture();
    const duplicate = structuredClone(f.data);
    duplicate.sources.push({ ...duplicate.sources[0] });
    expect(
      readProviderOriginalMessages(
        renderProviderOriginalMessages(duplicate),
        duplicate,
      ),
    ).toBeUndefined();
    duplicate.sources = [{ ...duplicate.sources[0], id: "h1" }];
    expect(
      readProviderOriginalMessages(
        renderProviderOriginalMessages(duplicate),
        duplicate,
      ),
    ).toBeUndefined();
    f.context.events.push({ ...f.context.events[0], id: "another-provider" });
    expect(providerOriginals(f.context)).toBeUndefined();
  });
  it("rejects provider IDs used as current-room history selectors", () => {
    const f = fixture();
    expect(
      resolveSourceReply(f.context, f.snapshot, {
        ...f.raw,
        completionContext: {
          mode: "relevant_prior_dialogue",
          sourceSetId: f.snapshot.sourceSetId,
          complete: true,
          relevantSourceIds: ["recalled1"],
          constraintSourceIds: [],
          referentSourceIds: [],
          pendingIntentSourceIds: [],
        },
      }),
    ).toBeUndefined();
  });
});

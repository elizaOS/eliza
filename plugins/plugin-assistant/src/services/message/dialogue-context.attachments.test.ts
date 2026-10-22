/** Prior messages keep their attachments in dialogue history. The reply is the
 * stored shape of a Discord GENERATE_MEDIA reply. Its history showed "here's
 * your image." without the image, and the agent then denied it could generate
 * images. */
import {
  type ContextEvent,
  completionContextSources,
  createContextObject,
  type IAgentRuntime,
  type Memory,
  OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
  type State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { appendPriorDialogueEvents } from "./dialogue-context.ts";
import { createSourceReplySnapshot, resolveSourceReply } from "./source-reply";

const runtime = {
  agentId: "agent",
  character: { name: "Eliza" },
} as IAgentRuntime;
const GENERATED_PROMPT =
  "candid photograph of a young guy wearing a red and gray jacket, standing in front of an elephant enclosure at a zoo, looking straight at the camera, realistic smartphone photo, no watermark, no text overlay";
const request = {
  id: "request",
  roomId: "room",
  agentId: "agent",
  entityId: "user",
  createdAt: 1,
  content: {
    text: "can u try to gen that image again pls",
    senderName: "Sam",
    source: "discord",
  },
} as Memory;
const generated = {
  id: "generated",
  roomId: "room",
  agentId: "agent",
  entityId: "agent",
  createdAt: 2,
  content: {
    text: "here's your image.",
    source: "discord",
    actions: ["GENERATE_MEDIA"],
    thought: "Generate the image.",
    attachments: [
      {
        id: "55996081-1122-416e-badd-add56c361caf",
        url: "https://blob.eliza.app/generations/images/658088ec/3b0705d0.jpg",
        title: "Generated_Image_2026-10-18T18-24-25.jpg",
        source: "media-generation",
        mimeType: "image/png",
        contentType: "image",
        description: GENERATED_PROMPT,
      },
    ],
  },
} as Memory;
const message = {
  id: "current",
  roomId: "room",
  agentId: "agent",
  entityId: "user",
  createdAt: 3,
  content: { text: "LOL", source: "discord" },
} as Memory;

function render(memories: Memory[], recentInteractions: Memory[] = []) {
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    runtime,
    {
      data: {
        providers: {
          RECENT_MESSAGES: {
            data: {
              recentMessages: memories,
              recentInteractions,
              recentInteractionsDisclosure:
                OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
            },
          },
        },
      },
    } as State,
    message,
    { includeOwnReplies: true },
  );
  return events;
}
const content = (events: ContextEvent[], id: string) => {
  const event = events.find((candidate) => candidate.id === id);
  if (!event || !("segment" in event)) throw Error(`missing ${id}`);
  return event.segment.content;
};

describe("attachments in prior dialogue", () => {
  it("renders the agent's generated image beside its reply, without URL, actions or thought", () => {
    const shown = content(render([request, generated]), "history:generated");
    expect(shown).toBe(
      `Eliza: here's your image. [attachment: Generated_Image_2026-10-18T18-24-25.jpg; image/png; ${GENERATED_PROMPT}]`,
    );
    expect(shown).not.toContain("https://");
    expect(shown).not.toContain("GENERATE_MEDIA");
    expect(shown).not.toContain("Generate the image.");
  });

  it("keeps messages without attachments and the hN numbering unchanged", () => {
    const events = render([request, generated]);
    expect(content(events, "history:request")).toBe(
      "Sam: can u try to gen that image again pls",
    );
    const context = createContextObject({
      id: "turn",
      metadata: { roomId: "room", messageId: message.id },
      events,
    });
    expect(
      completionContextSources(context).sources.map((source) => source.id),
    ).toEqual(["h1", "h2"]);
  });

  it("adds same-room descriptions and preserves complete cross-room attachment text", () => {
    const withText = {
      ...generated,
      content: {
        ...generated.content,
        attachments: [
          { ...generated.content.attachments?.[0], text: "FULL TRANSCRIPT" },
        ],
      },
    } as Memory;
    const elsewhere = { ...withText, id: "elsewhere", roomId: "dm" } as Memory;
    const sameRoom = content(render([withText]), "history:generated");
    expect(sameRoom).toBe(content(render([generated]), "history:generated"));
    expect(sameRoom).not.toContain("FULL TRANSCRIPT");
    const crossRoom = content(
      render([], [elsewhere]),
      "verified-cross-room:elsewhere",
    );
    expect(crossRoom).toContain("FULL TRANSCRIPT");
    expect(crossRoom).toContain("here's your image.");
  });

  it("still quotes the original text of a message with attachments", () => {
    const context = createContextObject({
      id: "turn",
      metadata: { roomId: "room", messageId: message.id },
      events: render([request, generated]),
    });
    const sourceSetId = completionContextSources(context).sourceSetId;
    const snapshot = createSourceReplySnapshot(
      context,
      {
        sourceSetId,
        scope: { agentId: "agent", roomId: "room" },
        visibleEventIds: new Set(["history:request", "history:generated"]),
        loadedSourceIds: new Set(),
      },
      [request, generated],
    );
    expect(snapshot?.originals.get("h2")).toBe("here's your image.");
    if (!snapshot) throw Error("snapshot");
    const resolved = resolveSourceReply(context, snapshot, {
      replyText: [
        { kind: "text", value: "I said: " },
        { kind: "source", value: "h2" },
      ],
      completionContext: {
        mode: "relevant_prior_dialogue",
        complete: true,
        sourceSetId,
        relevantSourceIds: ["h2"],
        constraintSourceIds: [],
        referentSourceIds: [],
        pendingIntentSourceIds: [],
      },
    });
    expect(resolved?.replyText).toBe("I said: \n\nhere's your image.");
  });
});

/**
 * Unit coverage for the ATTACHMENTS provider (`attachmentsProvider`): room
 * attachments render whatever the wording or language of the request; they
 * stay out of sub-agent result turns; and an `ATTACHMENT action=read` is
 * advertised only when readable text is stored — with images the exception
 * when a vision (`IMAGE_DESCRIPTION`) model is registered. Deterministic
 * harness: a hand-stubbed runtime, no live model or DB.
 */

import {
  type IAgentRuntime,
  type Memory,
  ModelType,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { attachmentsProvider } from "./attachments.ts";

const roomId = "00000000-0000-0000-0000-000000000001" as UUID;
const agentId = "00000000-0000-0000-0000-0000000000a9" as UUID;
const userId = "00000000-0000-0000-0000-000000000002" as UUID;

function attachmentMemory(createdAt = 1): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000011" as UUID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    roomId,
    createdAt,
    content: {
      text: "old link",
      attachments: [
        {
          id: "webpage-old",
          url: "https://example.test/old-link",
          title: "Old Link",
          source: "Web",
          contentType: "link",
          text: "old page text",
        },
      ],
    },
  } as Memory;
}

function makeRuntime(
  recentMessages: Memory[],
  options: {
    hasImageDescriptionModel?: boolean;
    onHistoryFetch?: () => void;
  } = {},
): IAgentRuntime {
  return {
    agentId,
    getConversationLength: () => 20,
    getMemories: async () => {
      options.onHistoryFetch?.();
      return recentMessages;
    },
    getRoom: async () => null,
    getModel: (modelType: string) =>
      options.hasImageDescriptionModel &&
      modelType === ModelType.IMAGE_DESCRIPTION
        ? async () => ({ title: "", description: "" })
        : undefined,
    logger: { warn: () => undefined },
  } as unknown as IAgentRuntime;
}

function makeMessage(content: Partial<Memory["content"]>): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000012" as UUID,
    entityId: userId,
    roomId,
    createdAt: 2,
    content: {
      text: "can you try this?",
      ...content,
    },
  } as Memory;
}

function ownerPrivateAttachmentMemory(granted = false): Memory {
  return {
    ...attachmentMemory(1),
    metadata: {
      scope: "owner-private",
      share: granted
        ? {
            grants: [
              {
                entityId: userId,
                mode: "redacted",
              },
            ],
          }
        : undefined,
    },
    content: {
      text: "private image",
      attachments: [
        {
          id: "private-image",
          url: "https://example.test/private-original.jpg",
          redactedUrl: "https://example.test/private-redacted.jpg",
          thumbnailUrl: "https://example.test/private-thumb.jpg",
          title: "Private Image",
          source: "Image",
          contentType: "image",
          text: "original visible text",
          description: "original description",
        },
      ],
    },
  } as Memory;
}

describe("attachmentsProvider", () => {
  it("renders room attachments whatever the wording or language of the request", async () => {
    for (const text of [
      "can u try to gen that image again pls",
      "¿puedes volver a generar esa imagen?",
      "その画像をもう一度作って",
    ]) {
      const result = await attachmentsProvider.get(
        makeRuntime([attachmentMemory()]),
        makeMessage({ text }),
      );

      expect(result.text).toContain("# Attachments");
      expect(result.text).toContain("webpage-old");
    }
  });

  it("advertises a read for an earlier room image without stored text whatever the wording of the request (#37027)", async () => {
    // A generated image from an earlier turn carries no stored text. A
    // follow-up regeneration request (no inspection verb, or not English)
    // must still see it and its satisfiable ATTACHMENT read.
    const generatedImageMemory = {
      ...attachmentMemory(1),
      content: {
        text: "here is your image",
        attachments: [
          {
            id: "generated-image",
            url: "https://example.test/generated.png",
            title: "generated.png",
            source: "Image",
            contentType: "image",
            text: "",
          },
        ],
      },
    } as Memory;
    for (const text of [
      "can u try to gen that image again pls",
      "¿puedes volver a generar esa imagen?",
    ]) {
      const result = await attachmentsProvider.get(
        makeRuntime([generatedImageMemory], { hasImageDescriptionModel: true }),
        makeMessage({ text }),
      );

      expect(result.text).toContain("ID: generated-image");
      expect(result.text).toContain(
        "Stored Content: available via ATTACHMENT action=read",
      );
    }
  });

  it("lists the room's attachments on a turn that does not mention media, and nothing for a room without attachments", async () => {
    const withAttachments = await attachmentsProvider.get(
      makeRuntime([attachmentMemory()]),
      makeMessage({ text: "can you try this?" }),
    );
    const withoutAttachments = await attachmentsProvider.get(
      makeRuntime([makeMessage({ text: "earlier text-only message" })]),
      makeMessage({ text: "can you try this?" }),
    );

    expect(withAttachments.text).toContain("# Attachments");
    expect(withAttachments.text).toContain("webpage-old");
    expect(withoutAttachments.text).toBe("");
    expect(withoutAttachments.data?.visibleAttachments).toEqual([]);
  });

  it("does not inject stale room attachments into sub-agent result turns", async () => {
    let historyFetches = 0;
    const result = await attachmentsProvider.get(
      makeRuntime([attachmentMemory()], {
        onHistoryFetch: () => {
          historyFetches += 1;
        },
      }),
      makeMessage({
        source: "sub_agent",
        text: "[sub-agent: app-build (opencode) — task_complete]\nResult: https://example.test/apps/demo/",
      }),
    );

    expect(result.text).toBe("");
    expect(result.data?.visibleAttachments).toHaveLength(0);
    expect(historyFetches).toBe(0);
  });

  it("does not advertise an ATTACHMENT read for a failure-prose description without stored text", async () => {
    // 2026-06-10 incident: mp4 transcription failed (no ffprobe) so the
    // attachment carried only placeholder prose in description with empty
    // text; the advertised read was unsatisfiable and the turn died in a
    // forced-tool IGNORE loop.
    const result = await attachmentsProvider.get(
      makeRuntime([]),
      makeMessage({
        text: "How can I max profit from this",
        attachments: [
          {
            id: "generated-video",
            url: "https://cdn.discordapp.test/attachments/1/2/Generated_Video.mp4",
            title: "Generated_Video.mp4",
            source: "Video",
            contentType: "video",
            description: "An audio/video attachment (transcription failed)",
            text: "",
          },
        ],
      }),
    );

    expect(result.text).toContain("Stored Content: none");
    expect(result.text).not.toContain("available via ATTACHMENT action=read");
  });

  it("advertises an ATTACHMENT read when readable text is stored", async () => {
    const result = await attachmentsProvider.get(
      makeRuntime([]),
      makeMessage({
        text: "How can I max profit from this",
        attachments: [
          {
            id: "generated-video",
            url: "https://cdn.discordapp.test/attachments/1/2/Generated_Video.mp4",
            title: "Generated_Video.mp4",
            source: "Video",
            contentType: "video",
            description: "A clip about the coffee shop",
            text: "welcome to the coffee shop, home of the $50 latte",
          },
        ],
      }),
    );

    expect(result.text).toContain(
      "Stored Content: available via ATTACHMENT action=read",
    );
  });

  it("advertises a read for a failed-ingest image when a vision model is registered", async () => {
    // The read action re-describes IMAGEs at read time, so a working-vision
    // deploy can satisfy the read even though ingest stored only the
    // failure placeholder.
    const result = await attachmentsProvider.get(
      makeRuntime([], { hasImageDescriptionModel: true }),
      makeMessage({
        text: "what is in this image?",
        attachments: [
          {
            id: "failed-ingest-image",
            url: "https://cdn.discordapp.test/attachments/1/3/photo.png",
            title: "photo.png",
            source: "Image",
            contentType: "image",
            description: "An image attachment (recognition failed)",
            text: "",
          },
        ],
      }),
    );

    expect(result.text).toContain(
      "Stored Content: available via ATTACHMENT action=read",
    );
  });

  it("does not advertise a read for a failed-ingest image without a vision model", async () => {
    const result = await attachmentsProvider.get(
      makeRuntime([], { hasImageDescriptionModel: false }),
      makeMessage({
        text: "what is in this image?",
        attachments: [
          {
            id: "failed-ingest-image",
            url: "https://cdn.discordapp.test/attachments/1/3/photo.png",
            title: "photo.png",
            source: "Image",
            contentType: "image",
            description: "An image attachment (recognition failed)",
            text: "",
          },
        ],
      }),
    );

    expect(result.text).toContain("Stored Content: none");
  });

  it("omits owner-private recent attachments from model prompt context without a grant", async () => {
    const result = await attachmentsProvider.get(
      makeRuntime([ownerPrivateAttachmentMemory(false)]),
      makeMessage({ text: "can you inspect the image attachment?" }),
    );

    expect(result.text).toBe("");
    expect(result.data?.visibleAttachments).toEqual([]);
  });

  it("renders only the redacted URL for a redacted attachment grant", async () => {
    const result = await attachmentsProvider.get(
      makeRuntime([ownerPrivateAttachmentMemory(true)]),
      makeMessage({ text: "can you inspect the image attachment?" }),
    );

    expect(result.text).toContain("private-image");
    expect(result.text).toContain("https://example.test/private-redacted.jpg");
    expect(result.text).not.toContain("private-original");
    expect(result.text).not.toContain("private-thumb");
    expect(result.text).toContain("Stored Content: none");
  });
});

/**
 * Unit tests for the attachment→knowledge ingest pipeline (#13593):
 * media-format derivation, scope-by-source-trust (owner/DM → owner-private,
 * public room → user-private), the ingest happy path (one knowledge doc per
 * store-backed attachment with correct sha256 link, tags, roomId, addedBy/role),
 * unsupported-source handling (remote/ephemeral URLs skipped, agent's own
 * outgoing attachments skipped), idempotency delegation, and fail-fast typed
 * errors.
 */
import {
  ChannelType,
  ContentType,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type AttachmentIngestDocumentService,
  attachmentKnowledgeTags,
  ingestMessageAttachmentsAsKnowledge,
  mediaFormatFromMimeType,
  registerAttachmentKnowledgeIngestHook,
  resolveIngestScope,
  roomIsPrivateSurface,
} from "./attachment-knowledge-ingest.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OWNER_ENTITY = "00000000-0000-0000-0000-0000000000b1" as UUID;
const USER_ENTITY = "00000000-0000-0000-0000-0000000000c2" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;
const DM_ROOM = "00000000-0000-0000-0000-0000000000e1" as UUID;
const PUBLIC_ROOM = "00000000-0000-0000-0000-0000000000e2" as UUID;

const STORED_IMAGE_URL =
  "/api/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
const STORED_PDF_URL =
  "/api/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf";

describe("mediaFormatFromMimeType", () => {
  it("derives coarse format from mime type", () => {
    expect(mediaFormatFromMimeType("image/png")).toBe("image");
    expect(mediaFormatFromMimeType("audio/mpeg")).toBe("audio");
    expect(mediaFormatFromMimeType("video/mp4")).toBe("video");
    expect(mediaFormatFromMimeType("application/pdf")).toBe("pdf");
    expect(mediaFormatFromMimeType("text/plain")).toBe("text");
    expect(mediaFormatFromMimeType("application/json")).toBe("text");
    expect(mediaFormatFromMimeType("application/zip")).toBe("file");
  });

  it("falls back to ContentType when mime is missing/unknown", () => {
    expect(mediaFormatFromMimeType(undefined, ContentType.IMAGE)).toBe("image");
    expect(mediaFormatFromMimeType("", ContentType.AUDIO)).toBe("audio");
    expect(mediaFormatFromMimeType(undefined, ContentType.DOCUMENT)).toBe(
      "file",
    );
    expect(mediaFormatFromMimeType(undefined)).toBe("file");
  });

  it("builds the ordered attachment + media-format tag set", () => {
    expect(attachmentKnowledgeTags("pdf")).toEqual([
      "attachment",
      "media-format:pdf",
    ]);
  });
});

describe("roomIsPrivateSurface / resolveIngestScope (spill guard)", () => {
  it("treats DM/SELF/VOICE_DM/API as private surfaces, others public", () => {
    expect(roomIsPrivateSurface(ChannelType.DM)).toBe(true);
    expect(roomIsPrivateSurface(ChannelType.SELF)).toBe(true);
    expect(roomIsPrivateSurface(ChannelType.VOICE_DM)).toBe(true);
    expect(roomIsPrivateSurface(ChannelType.API)).toBe(true);
    expect(roomIsPrivateSurface(ChannelType.GROUP)).toBe(false);
    expect(roomIsPrivateSurface(ChannelType.FORUM)).toBe(false);
    expect(roomIsPrivateSurface(undefined)).toBe(false);
  });

  it("owner in a DM → owner-private", () => {
    expect(
      resolveIngestScope({
        channelType: ChannelType.DM,
        senderIsOwner: true,
        senderEntityId: OWNER_ENTITY,
      }),
    ).toEqual({ scope: "owner-private" });
  });

  it("owner in a PUBLIC room → user-private scoped to owner (never spills)", () => {
    expect(
      resolveIngestScope({
        channelType: ChannelType.GROUP,
        senderIsOwner: true,
        senderEntityId: OWNER_ENTITY,
      }),
    ).toEqual({ scope: "user-private", scopedToEntityId: OWNER_ENTITY });
  });

  it("non-owner in a DM → user-private (owner-private reserved for owner)", () => {
    expect(
      resolveIngestScope({
        channelType: ChannelType.DM,
        senderIsOwner: false,
        senderEntityId: USER_ENTITY,
      }),
    ).toEqual({ scope: "user-private", scopedToEntityId: USER_ENTITY });
  });

  it("non-owner in a PUBLIC room → user-private scoped to sender", () => {
    expect(
      resolveIngestScope({
        channelType: ChannelType.GROUP,
        senderIsOwner: false,
        senderEntityId: USER_ENTITY,
      }),
    ).toEqual({ scope: "user-private", scopedToEntityId: USER_ENTITY });
  });
});

type AddDocumentCall = Parameters<
  AttachmentIngestDocumentService["addDocument"]
>[0];

function makeDocumentService(): {
  service: AttachmentIngestDocumentService;
  calls: AddDocumentCall[];
} {
  const calls: AddDocumentCall[] = [];
  let counter = 0;
  const service: AttachmentIngestDocumentService = {
    addDocument: vi.fn(async (options: AddDocumentCall) => {
      calls.push(options);
      counter += 1;
      return {
        clientDocumentId: `doc-${counter}` as UUID,
        storedDocumentMemoryId: `mem-${counter}` as UUID,
        fragmentCount: 1,
      };
    }),
  };
  return { service, calls };
}

function makeRuntime(params: {
  roomType: ChannelType;
  roomId: UUID;
  ownerId?: UUID;
}) {
  const { roomType, ownerId } = params;
  return {
    agentId: AGENT_ID,
    getRoom: vi.fn(async (id: UUID) => ({
      id,
      type: roomType,
      worldId: WORLD_ID,
      source: "test",
    })),
    getWorld: vi.fn(async (worldId: UUID) => ({
      id: worldId,
      metadata: {
        roles: {
          ...(ownerId ? { [ownerId]: "OWNER" } : {}),
          [USER_ENTITY]: "USER",
        },
        ...(ownerId ? { ownership: { ownerId } } : {}),
      },
    })),
    getSetting: vi.fn(() => undefined),
    getEntityById: vi.fn(async () => null),
    getRelationships: vi.fn(async () => []),
    reportError: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as Record<string, unknown>;
}

function messageWithAttachments(
  overrides: Partial<Memory> & {
    attachments: NonNullable<Memory["content"]["attachments"]>;
    entityId: UUID;
    roomId: UUID;
  },
): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000ff" as UUID,
    entityId: overrides.entityId,
    agentId: AGENT_ID,
    roomId: overrides.roomId,
    worldId: WORLD_ID,
    content: {
      text: "here you go",
      attachments: overrides.attachments,
    },
    createdAt: Date.now(),
  } as Memory;
}

describe("ingestMessageAttachmentsAsKnowledge", () => {
  it("files one owner-private doc per stored attachment from an owner DM, linked to sha256", async () => {
    const { service, calls } = makeDocumentService();
    const runtime = makeRuntime({
      roomType: ChannelType.DM,
      roomId: DM_ROOM,
      ownerId: OWNER_ENTITY,
    });
    const message = messageWithAttachments({
      entityId: OWNER_ENTITY,
      roomId: DM_ROOM,
      attachments: [
        {
          id: "a1",
          url: STORED_IMAGE_URL,
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
          filename: "chart.png",
          description: "a bar chart of Q3 revenue",
        },
        {
          id: "a2",
          url: STORED_PDF_URL,
          contentType: ContentType.DOCUMENT,
          mimeType: "application/pdf",
          filename: "report.pdf",
        },
      ],
    });

    const results = await ingestMessageAttachmentsAsKnowledge(
      { runtime, documents: service } as never,
      message,
    );

    expect(results).toHaveLength(2);
    expect(calls).toHaveLength(2);

    const image = calls[0];
    expect(image.scope).toBe("owner-private");
    expect(image.scopedToEntityId).toBeUndefined();
    expect(image.addedBy).toBe(OWNER_ENTITY);
    expect(image.addedByRole).toBe("OWNER");
    expect(image.addedFrom).toBe("chat");
    expect(image.roomId).toBe(DM_ROOM);
    expect(image.metadata?.roomId).toBe(DM_ROOM);
    expect(image.metadata?.mediaFormat).toBe("image");
    expect(image.metadata?.tags).toEqual(["attachment", "media-format:image"]);
    expect(image.metadata?.mediaUrl).toBe(STORED_IMAGE_URL);
    expect(image.metadata?.mediaFileName).toBe(
      STORED_IMAGE_URL.replace("/api/media/", ""),
    );
    // Description text is used as the searchable body.
    expect(image.content).toContain("Q3 revenue");
    // A context provenance line (room/sender/scope) is appended so the
    // documents store's content-addressed dedupe is context-scoped.
    expect(image.content).toContain(`room=${DM_ROOM}`);
    expect(image.content).toContain(`sender=${OWNER_ENTITY}`);
    expect(image.content).toContain("scope=owner-private");

    const pdf = calls[1];
    expect(pdf.scope).toBe("owner-private");
    expect(pdf.metadata?.mediaFormat).toBe("pdf");
    expect(pdf.metadata?.tags).toEqual(["attachment", "media-format:pdf"]);
    // A PDF attachment is stored as a text record under a .txt name so the
    // documents service does NOT run the .pdf base64-decode/extract path on the
    // synthesized plaintext body. The display filename is preserved in metadata.
    expect(pdf.contentType).toBe("text/plain");
    expect(pdf.originalFilename).toBe("report.txt");
    expect(pdf.metadata?.filename).toBe("report.pdf");
  });

  it("scopes a public-room attachment to the sender (user-private), never owner-private/global", async () => {
    const { service, calls } = makeDocumentService();
    const runtime = makeRuntime({
      roomType: ChannelType.GROUP,
      roomId: PUBLIC_ROOM,
      ownerId: OWNER_ENTITY,
    });
    const message = messageWithAttachments({
      entityId: USER_ENTITY,
      roomId: PUBLIC_ROOM,
      attachments: [
        {
          id: "b1",
          url: STORED_IMAGE_URL,
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
          filename: "meme.png",
        },
      ],
    });

    const results = await ingestMessageAttachmentsAsKnowledge(
      { runtime, documents: service } as never,
      message,
    );

    expect(results).toHaveLength(1);
    const call = calls[0];
    expect(call.scope).toBe("user-private");
    expect(call.scopedToEntityId).toBe(USER_ENTITY);
    expect(call.entityId).toBe(USER_ENTITY);
    expect(call.addedByRole).toBe("USER");
    expect(call.scope).not.toBe("owner-private");
    expect(call.scope).not.toBe("global");
  });

  it("even the OWNER speaking in a public room does not get owner-private (spill guard)", async () => {
    const { service, calls } = makeDocumentService();
    const runtime = makeRuntime({
      roomType: ChannelType.GROUP,
      roomId: PUBLIC_ROOM,
      ownerId: OWNER_ENTITY,
    });
    const message = messageWithAttachments({
      entityId: OWNER_ENTITY,
      roomId: PUBLIC_ROOM,
      attachments: [
        {
          id: "c1",
          url: STORED_PDF_URL,
          contentType: ContentType.DOCUMENT,
          mimeType: "application/pdf",
          filename: "secret.pdf",
        },
      ],
    });

    await ingestMessageAttachmentsAsKnowledge(
      { runtime, documents: service } as never,
      message,
    );

    const call = calls[0];
    expect(call.scope).toBe("user-private");
    expect(call.scopedToEntityId).toBe(OWNER_ENTITY);
    expect(call.scope).not.toBe("owner-private");
  });

  it("skips attachments whose bytes are not in the store (remote/ephemeral)", async () => {
    const { service, calls } = makeDocumentService();
    const runtime = makeRuntime({
      roomType: ChannelType.DM,
      roomId: DM_ROOM,
      ownerId: OWNER_ENTITY,
    });
    const message = messageWithAttachments({
      entityId: OWNER_ENTITY,
      roomId: DM_ROOM,
      attachments: [
        {
          id: "r1",
          url: "https://cdn.example.com/x.png",
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
        },
        {
          id: "s1",
          url: STORED_IMAGE_URL,
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
        },
      ],
    });

    const results = await ingestMessageAttachmentsAsKnowledge(
      { runtime, documents: service } as never,
      message,
    );

    expect(results).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.mediaUrl).toBe(STORED_IMAGE_URL);
  });

  it("throws a typed ElizaError if a document write fails (fail fast, never silent)", async () => {
    const service: AttachmentIngestDocumentService = {
      addDocument: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const runtime = makeRuntime({
      roomType: ChannelType.DM,
      roomId: DM_ROOM,
      ownerId: OWNER_ENTITY,
    });
    const message = messageWithAttachments({
      entityId: OWNER_ENTITY,
      roomId: DM_ROOM,
      attachments: [
        {
          id: "f1",
          url: STORED_IMAGE_URL,
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
        },
      ],
    });

    await expect(
      ingestMessageAttachmentsAsKnowledge(
        { runtime, documents: service } as never,
        message,
      ),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_KNOWLEDGE_INGEST_FAILED",
    });
  });

  it("throws typed lookup errors instead of fabricating room/role defaults", async () => {
    const { service } = makeDocumentService();
    const message = messageWithAttachments({
      entityId: OWNER_ENTITY,
      roomId: DM_ROOM,
      attachments: [
        {
          id: "lookup",
          url: STORED_IMAGE_URL,
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
        },
      ],
    });

    const roomLookupRuntime = makeRuntime({
      roomType: ChannelType.DM,
      roomId: DM_ROOM,
      ownerId: OWNER_ENTITY,
    }) as Record<string, unknown>;
    roomLookupRuntime.getRoom = vi.fn(async () => {
      throw new Error("room store down");
    });

    await expect(
      ingestMessageAttachmentsAsKnowledge(
        {
          runtime: roomLookupRuntime,
          documents: service,
        } as never,
        message,
      ),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_KNOWLEDGE_ROOM_LOOKUP_FAILED",
    });

    const worldLookupRuntime = makeRuntime({
      roomType: ChannelType.DM,
      roomId: DM_ROOM,
      ownerId: OWNER_ENTITY,
    }) as Record<string, unknown>;
    worldLookupRuntime.getWorld = vi.fn(async () => {
      throw new Error("world store down");
    });

    await expect(
      ingestMessageAttachmentsAsKnowledge(
        {
          runtime: worldLookupRuntime,
          documents: service,
        } as never,
        message,
      ),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_KNOWLEDGE_WORLD_LOOKUP_FAILED",
    });
  });

  it("gives DIFFERENT bytes with the same filename+description distinct content (media hash in body)", async () => {
    const { service, calls } = makeDocumentService();
    const runtime = makeRuntime({
      roomType: ChannelType.DM,
      roomId: DM_ROOM,
      ownerId: OWNER_ENTITY,
    });
    // Two DISTINCT stored files (different sha256) that share filename +
    // description — without the media hash in the body they'd dedupe and the
    // second file's mediaUrl/hash would be lost.
    const message = messageWithAttachments({
      entityId: OWNER_ENTITY,
      roomId: DM_ROOM,
      attachments: [
        {
          id: "dup1",
          url: STORED_IMAGE_URL,
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
          filename: "same.png",
          description: "same description",
        },
        {
          id: "dup2",
          url: "/api/media/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png",
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
          filename: "same.png",
          description: "same description",
        },
      ],
    });

    await ingestMessageAttachmentsAsKnowledge(
      { runtime, documents: service } as never,
      message,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].content).not.toBe(calls[1].content);
    expect(calls[0].metadata?.mediaFileName).not.toBe(
      calls[1].metadata?.mediaFileName,
    );
  });

  it("gives the SAME bytes distinct content per (room, sender, scope) so dedupe doesn't drop facets", async () => {
    const attachment = {
      id: "dup",
      url: STORED_IMAGE_URL,
      contentType: ContentType.IMAGE,
      mimeType: "image/png",
      filename: "shared.png",
      description: "the same shared image",
    };

    // Same bytes, owner DM.
    const { service: svc1, calls: calls1 } = makeDocumentService();
    await ingestMessageAttachmentsAsKnowledge(
      {
        runtime: makeRuntime({
          roomType: ChannelType.DM,
          roomId: DM_ROOM,
          ownerId: OWNER_ENTITY,
        }),
        documents: svc1,
      } as never,
      messageWithAttachments({
        entityId: OWNER_ENTITY,
        roomId: DM_ROOM,
        attachments: [attachment],
      }),
    );

    // Same bytes, different user in a public room.
    const { service: svc2, calls: calls2 } = makeDocumentService();
    await ingestMessageAttachmentsAsKnowledge(
      {
        runtime: makeRuntime({
          roomType: ChannelType.GROUP,
          roomId: PUBLIC_ROOM,
          ownerId: OWNER_ENTITY,
        }),
        documents: svc2,
      } as never,
      messageWithAttachments({
        entityId: USER_ENTITY,
        roomId: PUBLIC_ROOM,
        attachments: [attachment],
      }),
    );

    // Distinct content bodies → distinct content-addressed ids → the public-room
    // record does not shadow the owner's DM record (no scope/facet loss).
    expect(calls1[0].content).not.toBe(calls2[0].content);
    expect(calls1[0].scope).toBe("owner-private");
    expect(calls2[0].scope).toBe("user-private");
  });

  it("returns nothing for a message with no attachments", async () => {
    const { service } = makeDocumentService();
    const runtime = makeRuntime({
      roomType: ChannelType.DM,
      roomId: DM_ROOM,
      ownerId: OWNER_ENTITY,
    });
    const message = {
      id: "00000000-0000-0000-0000-0000000000f0" as UUID,
      entityId: OWNER_ENTITY,
      agentId: AGENT_ID,
      roomId: DM_ROOM,
      worldId: WORLD_ID,
      content: { text: "no files here" },
      createdAt: Date.now(),
    } as Memory;

    const results = await ingestMessageAttachmentsAsKnowledge(
      { runtime, documents: service } as never,
      message,
    );
    expect(results).toEqual([]);
  });
});

describe("registerAttachmentKnowledgeIngestHook", () => {
  type CapturedHook = {
    id: string;
    phase: string;
    handler: (rt: unknown, ctx: unknown) => unknown;
  };

  function captureRuntime(documents: unknown) {
    let hook: CapturedHook | null = null;
    const runtime = {
      agentId: AGENT_ID,
      registerPipelineHook: (spec: CapturedHook) => {
        hook = spec;
      },
      getService: vi.fn((name: string) =>
        name === "documents" ? documents : null,
      ),
      getRoom: vi.fn(async (id: UUID) => ({
        id,
        type: ChannelType.DM,
        worldId: WORLD_ID,
        source: "test",
      })),
      getWorld: vi.fn(async (worldId: UUID) => ({
        id: worldId,
        metadata: {
          roles: { [OWNER_ENTITY]: "OWNER" },
          ownership: { ownerId: OWNER_ENTITY },
        },
      })),
      getSetting: vi.fn(() => undefined),
      getEntityById: vi.fn(async () => null),
      getRelationships: vi.fn(async () => []),
      reportError: vi.fn(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never;
    return {
      runtime,
      getHook: () => {
        if (!hook) throw new Error("hook not registered");
        return hook;
      },
    };
  }

  it("registers an after_memory_persisted reader hook", () => {
    const { service } = makeDocumentService();
    const { runtime, getHook } = captureRuntime(service);
    registerAttachmentKnowledgeIngestHook(runtime);
    const hook = getHook();
    expect(hook.phase).toBe("after_memory_persisted");
    expect(hook.id).toBe("attachment-knowledge-ingest");
  });

  it("ingests on a messages-table user attachment, ignores other tables", async () => {
    const { service, calls } = makeDocumentService();
    const { runtime, getHook } = captureRuntime(service);
    registerAttachmentKnowledgeIngestHook(runtime);
    const hook = getHook();

    const memory = messageWithAttachments({
      entityId: OWNER_ENTITY,
      roomId: DM_ROOM,
      attachments: [
        {
          id: "h1",
          url: STORED_IMAGE_URL,
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
        },
      ],
    });

    // Wrong table → no-op.
    await hook.handler(runtime, {
      phase: "after_memory_persisted",
      tableName: "documents",
      memoryId: memory.id,
      memory,
    });
    expect(calls).toHaveLength(0);

    // messages table → ingests.
    await hook.handler(runtime, {
      phase: "after_memory_persisted",
      tableName: "messages",
      memoryId: memory.id,
      memory,
    });
    expect(calls).toHaveLength(1);
  });

  it("skips the agent's own outgoing attachments", async () => {
    const { service, calls } = makeDocumentService();
    const { runtime, getHook } = captureRuntime(service);
    registerAttachmentKnowledgeIngestHook(runtime);
    const hook = getHook();

    const memory = messageWithAttachments({
      entityId: AGENT_ID, // agent is the sender
      roomId: DM_ROOM,
      attachments: [
        {
          id: "o1",
          url: STORED_IMAGE_URL,
          contentType: ContentType.IMAGE,
          mimeType: "image/png",
        },
      ],
    });

    await hook.handler(runtime, {
      phase: "after_memory_persisted",
      tableName: "messages",
      memoryId: memory.id,
      memory,
    });
    expect(calls).toHaveLength(0);
  });
});

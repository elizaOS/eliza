/**
 * Unit tests for the three global knowledge actions (#13595 / #13974):
 * SEARCH_KNOWLEDGE, ATTACH_TO_CHAT, SEND_MEDIA_TO. Focus is the scope wall +
 * the shaw-codex draft blockers:
 *
 *  - SEARCH_KNOWLEDGE: free-text AND filter-only (tag/facet) surfacing both work,
 *    and an owner-private/user-private item is NOT surfaced into a public active
 *    room even for an OWNER actor (active-room surfacing wall).
 *  - ATTACH_TO_CHAT: reports FAILURE (not success) when no chat callback is
 *    supplied, and refuses a private item into a public active room.
 *  - SEND_MEDIA_TO: refuses an owner-private/user-private item into a public
 *    target room INCLUDING a THREAD (previously omitted from the public set),
 *    and fails closed for an unresolvable target room.
 */
import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  attachToChatAction,
  searchKnowledgeAction,
  sendMediaToAction,
} from "./knowledge.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OWNER_ENTITY = "00000000-0000-0000-0000-0000000000b1" as UUID;
const USER_ENTITY = "00000000-0000-0000-0000-0000000000c2" as UUID;
const DM_ROOM = "00000000-0000-0000-0000-0000000000e1" as UUID;
const PUBLIC_ROOM = "00000000-0000-0000-0000-0000000000e2" as UUID;
const THREAD_ROOM = "00000000-0000-0000-0000-0000000000e3" as UUID;
const DOC_OWNER_PRIVATE = "00000000-0000-0000-0000-0000000000f1" as UUID;
const DOC_USER_PRIVATE = "00000000-0000-0000-0000-0000000000f2" as UUID;
const DOC_GLOBAL = "00000000-0000-0000-0000-0000000000f3" as UUID;

const STORED_PDF_URL =
  "/api/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf";

type DocRecord = {
  id: UUID;
  content: { text?: string };
  metadata: Record<string, unknown>;
  agentId?: UUID;
};

function doc(
  id: UUID,
  scope: string,
  extra: Record<string, unknown> = {},
): DocRecord {
  return {
    id,
    content: { text: `body of ${id}` },
    agentId: AGENT_ID,
    metadata: {
      type: "document",
      documentId: id,
      title: `title-${id}`,
      scope,
      mediaUrl: STORED_PDF_URL,
      mediaMimeType: "application/pdf",
      addedBy: scope === "owner-private" ? OWNER_ENTITY : USER_ENTITY,
      scopedToEntityId: scope === "user-private" ? USER_ENTITY : undefined,
      tags: ["attachment", "media-format:pdf"],
      ...extra,
    },
  };
}

const CORPUS: DocRecord[] = [
  doc(DOC_OWNER_PRIVATE, "owner-private"),
  doc(DOC_USER_PRIVATE, "user-private"),
  doc(DOC_GLOBAL, "global"),
];

function makeService(records: DocRecord[] = CORPUS) {
  return {
    searchDocuments: vi.fn(async () => records),
    getMemories: vi.fn(async ({ offset = 0 }: { offset?: number }) =>
      offset === 0 ? records : [],
    ),
    getDocumentById: vi.fn(
      async (id: UUID) => records.find((r) => r.id === id) ?? null,
    ),
    countMemories: vi.fn(async () => records.length),
  };
}

type RoomShape = { type: ChannelType; source?: string };

function makeRuntime(opts: {
  service: ReturnType<typeof makeService>;
  rooms?: Record<string, RoomShape>;
  sendMessageToTarget?: ReturnType<typeof vi.fn>;
}) {
  const rooms: Record<string, RoomShape> = opts.rooms ?? {
    [DM_ROOM]: { type: ChannelType.DM },
    [PUBLIC_ROOM]: { type: ChannelType.GROUP, source: "discord" },
    [THREAD_ROOM]: { type: ChannelType.THREAD, source: "discord" },
  };
  return {
    agentId: AGENT_ID,
    getSetting: (k: string) =>
      k === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY : undefined,
    getService: (name: string) => (name === "documents" ? opts.service : null),
    getRoom: async (id: UUID) => rooms[id] ?? null,
    getMemoryById: async (id: UUID) =>
      opts.service.getDocumentById(id) as unknown as Memory | null,
    sendMessageToTarget:
      opts.sendMessageToTarget ?? vi.fn(async () => ({ id: "sent-1" })),
  } as never;
}

function msg(entityId: UUID, roomId: UUID): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000ff" as UUID,
    entityId,
    agentId: AGENT_ID,
    roomId,
    content: { text: "" },
    createdAt: Date.now(),
  } as Memory;
}

const call = async (
  action: { handler: typeof searchKnowledgeAction.handler },
  runtime: never,
  message: Memory,
  parameters: Record<string, unknown>,
  callback?: (c: unknown, k: string) => Promise<void>,
) => {
  const result = await action.handler(
    runtime,
    message,
    undefined as never,
    { parameters } as never,
    callback as never,
  );
  if (!result) {
    throw new Error("Knowledge action did not return an action result.");
  }
  return result;
};

describe("SEARCH_KNOWLEDGE", () => {
  it("free-text search surfaces readable items", async () => {
    const runtime = makeRuntime({ service: makeService() });
    const res = await call(
      searchKnowledgeAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      {
        query: "body",
      },
    );
    expect(res.success).toBe(true);
    expect((res.data as { count: number }).count).toBeGreaterThan(0);
  });

  it("filter-only (no free text) surfacing works — the slice-3 tag search", async () => {
    const runtime = makeRuntime({ service: makeService() });
    const res = await call(
      searchKnowledgeAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      {
        tags: ["media-format:pdf"],
      },
    );
    expect(res.success).toBe(true);
    expect((res.data as { count: number }).count).toBeGreaterThan(0);
  });

  it("rejects a request with neither query nor any filter", async () => {
    const runtime = makeRuntime({ service: makeService() });
    const res = await call(
      searchKnowledgeAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      {},
    );
    expect(res.success).toBe(false);
    expect((res.data as { error: string }).error).toBe("KNOWLEDGE_INVALID");
  });

  it("owner-private item does NOT surface into a PUBLIC active room even for the OWNER", async () => {
    const runtime = makeRuntime({ service: makeService() });
    const res = await call(
      searchKnowledgeAction,
      runtime,
      msg(OWNER_ENTITY, PUBLIC_ROOM),
      {
        query: "body",
      },
    );
    const items = (res.data as { items: Array<{ id: UUID }> }).items;
    expect(items.some((i) => i.id === DOC_OWNER_PRIVATE)).toBe(false);
    expect(items.some((i) => i.id === DOC_USER_PRIVATE)).toBe(false);
    // global is fine
    expect(items.some((i) => i.id === DOC_GLOBAL)).toBe(true);
  });

  it("in a DM active room the OWNER can see their owner-private items", async () => {
    const runtime = makeRuntime({ service: makeService() });
    const res = await call(
      searchKnowledgeAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      {
        query: "body",
      },
    );
    const items = (res.data as { items: Array<{ id: UUID }> }).items;
    expect(items.some((i) => i.id === DOC_OWNER_PRIVATE)).toBe(true);
  });
});

describe("ATTACH_TO_CHAT", () => {
  it("fails (not success) when no chat callback is supplied", async () => {
    const runtime = makeRuntime({ service: makeService() });
    const res = await call(
      attachToChatAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      { itemId: DOC_GLOBAL },
      // no callback
    );
    expect(res.success).toBe(false);
    expect((res.data as { error: string }).error).toBe("ATTACH_NO_CALLBACK");
  });

  it("attaches a readable global item when a callback is present", async () => {
    const runtime = makeRuntime({ service: makeService() });
    const cb = vi.fn(async () => {});
    const res = await call(
      attachToChatAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      { itemId: DOC_GLOBAL },
      cb,
    );
    expect(res.success).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("refuses an owner-private item into a PUBLIC active room even with a callback", async () => {
    const runtime = makeRuntime({ service: makeService() });
    const cb = vi.fn(async () => {});
    const res = await call(
      attachToChatAction,
      runtime,
      msg(OWNER_ENTITY, PUBLIC_ROOM),
      { itemId: DOC_OWNER_PRIVATE },
      cb,
    );
    expect(res.success).toBe(false);
    expect((res.data as { error: string }).error).toBe("ATTACH_SCOPE_REFUSED");
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("SEND_MEDIA_TO", () => {
  it("refuses an owner-private item into a PUBLIC (GROUP) target room", async () => {
    const send = vi.fn(async () => ({ id: "x" }));
    const runtime = makeRuntime({
      service: makeService(),
      sendMessageToTarget: send,
    });
    const res = await call(
      sendMediaToAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      {
        itemId: DOC_OWNER_PRIVATE,
        roomId: PUBLIC_ROOM,
      },
    );
    expect(res.success).toBe(false);
    expect((res.data as { error: string }).error).toBe("SEND_SCOPE_REFUSED");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a private item into a THREAD (previously omitted from the public set)", async () => {
    const send = vi.fn(async () => ({ id: "x" }));
    const runtime = makeRuntime({
      service: makeService(),
      sendMessageToTarget: send,
    });
    const res = await call(
      sendMediaToAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      {
        itemId: DOC_OWNER_PRIVATE,
        roomId: THREAD_ROOM,
      },
    );
    expect(res.success).toBe(false);
    expect((res.data as { error: string }).error).toBe("SEND_SCOPE_REFUSED");
    expect(send).not.toHaveBeenCalled();
  });

  it("fails CLOSED for an unresolvable target room (treated as public)", async () => {
    const send = vi.fn(async () => ({ id: "x" }));
    const runtime = makeRuntime({
      service: makeService(),
      rooms: {},
      sendMessageToTarget: send,
    });
    const res = await call(
      sendMediaToAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      {
        itemId: DOC_OWNER_PRIVATE,
        roomId: PUBLIC_ROOM,
      },
    );
    expect(res.success).toBe(false);
    expect((res.data as { error: string }).error).toBe("SEND_SCOPE_REFUSED");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a global item into a public room (dispatch fires, typed ok)", async () => {
    const send = vi.fn(async () => ({ id: "sent-9" }));
    const runtime = makeRuntime({
      service: makeService(),
      sendMessageToTarget: send,
    });
    const res = await call(
      sendMediaToAction,
      runtime,
      msg(OWNER_ENTITY, DM_ROOM),
      {
        itemId: DOC_GLOBAL,
        roomId: PUBLIC_ROOM,
      },
    );
    expect(res.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect((res.data as { dispatch: { ok: boolean } }).dispatch.ok).toBe(true);
  });
});

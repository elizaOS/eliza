/**
 * Permission-aware document-augmentation test: proves the requester's
 * AccessContext is honored end-to-end through chat-augmentation into the
 * DocumentService search post-filter, so an owner-private fragment reaches a
 * privileged OWNER but never an unprivileged USER or an unauthenticated (blank
 * entityId) turn. Runs against an in-memory runtime with deterministic BM25
 * keyword recall (no embedding model registered), exercising the real filter.
 */
import {
  type AgentRuntime,
  type createMessageMemory,
  DocumentService,
  filterByAccessContext,
  type Memory,
  MemoryType,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { maybeAugmentChatMessageWithDocuments } from "./chat-augmentation.ts";

// ---------------------------------------------------------------------------
// Sociable test for the permission-aware FILTER threaded through the real
// chat-augmentation -> documents-service searchDocuments path.
//
// Proves end-to-end that a requester WITHOUT access does NOT get a document
// fragment that a privileged requester DOES get — and that the AccessContext
// is the causal lever (held the message constant, varied only the context,
// results differ), so the filter is honored at the query post-filter rather
// than accepted and ignored.
// ---------------------------------------------------------------------------

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000ff" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;
const OWNER_ENTITY = "00000000-0000-0000-0000-00000000bbbb" as UUID;
const USER_ENTITY = "00000000-0000-0000-0000-00000000dddd" as UUID;

const SECRET_TEXT = "the denver launch codeword is mallard";
const SECRET_QUERY = "denver launch codeword";

/** A single owner-private document fragment carrying the secret. */
function ownerPrivateFragment(): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000f001" as UUID,
    agentId: AGENT_ID,
    entityId: OWNER_ENTITY,
    roomId: ROOM_ID,
    worldId: WORLD_ID,
    content: { text: SECRET_TEXT },
    metadata: {
      type: MemoryType.FRAGMENT,
      documentId: "00000000-0000-0000-0000-00000000d001",
      scope: "owner-private",
      addedBy: OWNER_ENTITY,
      addedByRole: "OWNER",
      position: 0,
    },
  } as unknown as Memory;
}

/**
 * In-memory runtime backing both the role-resolution path
 * (`buildAccessContext`) and the documents keyword-search path
 * (`DocumentService`). No embedding model is registered, so search falls back
 * to deterministic BM25 keyword recall — no embeddings to mock.
 */
function makeRuntime(fragments: Memory[]): {
  runtime: AgentRuntime;
  documents: DocumentService;
} {
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "test-agent" },
    // role resolution: world owned by OWNER_ENTITY, USER_ENTITY is a plain USER
    getRoom: vi.fn(async (roomId: UUID) => ({ id: roomId, worldId: WORLD_ID })),
    getWorld: vi.fn(async (worldId: UUID) => ({
      id: worldId,
      metadata: {
        roles: { [OWNER_ENTITY]: "OWNER", [USER_ENTITY]: "USER" },
      },
    })),
    getEntityById: vi.fn(async () => null),
    getRelationships: vi.fn(async () => []),
    getSetting: vi.fn(() => undefined),
    // documents search backing
    getModel: vi.fn(() => undefined),
    getMemories: vi.fn(async () => fragments),
    searchMemories: vi.fn(async () => fragments),
    countMemories: vi.fn(async () => fragments.length),
    getServiceLoadPromise: vi.fn(),
    useModel: vi.fn(),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as AgentRuntime;

  const documents = new DocumentService(runtime);
  // chat-augmentation looks the service up via getService("documents") and
  // gates the search on a non-empty fragment count.
  (runtime as unknown as { getService: unknown }).getService = vi.fn(
    (name: string) => (name === "documents" ? documents : null),
  );
  return { runtime, documents };
}

function chatMessage(
  requesterEntityId: UUID,
): ReturnType<typeof createMessageMemory> {
  return {
    id: "00000000-0000-0000-0000-000000000001" as UUID,
    agentId: AGENT_ID,
    entityId: requesterEntityId,
    roomId: ROOM_ID,
    worldId: WORLD_ID,
    content: { text: `what is the ${SECRET_QUERY}?` },
    createdAt: Date.now(),
  } as unknown as ReturnType<typeof createMessageMemory>;
}

describe("chat augmentation honors the requester's AccessContext", () => {
  it("privileged owner gets the owner-private secret; unprivileged user does not", async () => {
    const fragments = [ownerPrivateFragment()];

    // Privileged requester (OWNER): the secret should be folded into the
    // augmented prompt.
    const owner = makeRuntime(fragments);
    const ownerResult = await maybeAugmentChatMessageWithDocuments(
      owner.runtime,
      chatMessage(OWNER_ENTITY),
    );
    const ownerText = (ownerResult.content as { text?: string }).text ?? "";
    expect(ownerText).toContain(SECRET_TEXT);
    expect(ownerText).toContain("<contextual_documents>");

    // Unprivileged requester (USER): identical query, identical corpus — but
    // the owner-private fragment must be filtered out, so the message is
    // returned UNAUGMENTED (no secret, no document block).
    const user = makeRuntime(fragments);
    const userMessage = chatMessage(USER_ENTITY);
    const userResult = await maybeAugmentChatMessageWithDocuments(
      user.runtime,
      userMessage,
    );
    const userText = (userResult.content as { text?: string }).text ?? "";
    expect(userText).not.toContain(SECRET_TEXT);
    expect(userText).not.toContain("<contextual_documents>");
    // The unaugmented message is returned as-is.
    expect(userResult).toBe(userMessage);
  });

  it("the AccessContext is the causal lever at the search post-filter (non-bypassable)", async () => {
    // Hold the search MESSAGE constant (its entityId is the agent itself, so
    // the documents service's own per-document role gate sees AGENT and would
    // return everything). Vary ONLY the AccessContext. If results differ, the
    // accessContext post-filter is the thing doing the filtering — proving it
    // is honored, not ignored.
    const fragments = [ownerPrivateFragment()];
    const { documents } = makeRuntime(fragments);

    const agentMessage = {
      id: "00000000-0000-0000-0000-000000000009" as UUID,
      agentId: AGENT_ID,
      entityId: AGENT_ID,
      roomId: ROOM_ID,
      content: { text: `what is the ${SECRET_QUERY}?` },
      createdAt: Date.now(),
    } as unknown as Memory;

    const ownerHits = await documents.searchDocuments(
      agentMessage,
      { roomId: ROOM_ID },
      "keyword",
      {
        requesterEntityId: OWNER_ENTITY,
        worldId: WORLD_ID,
        role: "OWNER",
        isOwner: true,
      },
    );
    expect(ownerHits.map((h) => h.content.text)).toContain(SECRET_TEXT);

    const userHits = await documents.searchDocuments(
      agentMessage,
      { roomId: ROOM_ID },
      "keyword",
      {
        requesterEntityId: USER_ENTITY,
        worldId: WORLD_ID,
        role: "USER",
        isOwner: false,
      },
    );
    expect(userHits.map((h) => h.content.text)).not.toContain(SECRET_TEXT);

    // And with NO accessContext the legacy single-tenant behaviour is intact:
    // the agent-as-sender sees the fragment (filter is opt-in, not forced).
    const unfiltered = await documents.searchDocuments(
      agentMessage,
      { roomId: ROOM_ID },
      "keyword",
    );
    expect(unfiltered.map((h) => h.content.text)).toContain(SECRET_TEXT);
  });

  it("an unauthenticated turn (blank entityId) is fail-closed on the full path", async () => {
    // A message with a blank entityId is coerced to a self-read inside
    // chat-augmentation (searchMessage.entityId becomes the agentId), which
    // disables the documents service's own per-document gate (it allow-alls
    // every agent self-read). The scope-read filter is therefore the SOLE
    // enforcement here: it must still strip the owner-private fragment so an
    // unauthenticated turn cannot surface the secret. This is the full path,
    // not the primitive in isolation — remove the filter and the secret leaks.
    const fragments = [ownerPrivateFragment()];
    const { runtime } = makeRuntime(fragments);

    const blankRequester = {
      ...chatMessage(USER_ENTITY),
      entityId: "   ",
    } as unknown as ReturnType<typeof createMessageMemory>;

    const result = await maybeAugmentChatMessageWithDocuments(
      runtime,
      blankRequester,
    );
    const text = (result.content as { text?: string }).text ?? "";
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain("<contextual_documents>");
    expect(result).toBe(blankRequester);
  });

  it("filterByAccessContext is the primitive doing the work", () => {
    const fragments = [ownerPrivateFragment()];
    const ownerView = filterByAccessContext(
      fragments,
      {
        requesterEntityId: OWNER_ENTITY,
        worldId: WORLD_ID,
        role: "OWNER",
        isOwner: true,
      },
      AGENT_ID,
    );
    const userView = filterByAccessContext(
      fragments,
      {
        requesterEntityId: USER_ENTITY,
        worldId: WORLD_ID,
        role: "USER",
        isOwner: false,
      },
      AGENT_ID,
    );
    expect(ownerView).toHaveLength(1);
    expect(userView).toHaveLength(0);
  });
});

/**
 * Permission-aware document augmentation against a real in-memory document
 * store. The requester's message identity drives adapter authorization, so an
 * owner-private fragment reaches its owner but never another user or an
 * unauthenticated turn.
 */
import {
  AgentRuntime,
  ChannelType,
  type createMessageMemory,
  type DocumentFragmentMemoryMetadata,
  type DocumentMemoryMetadata,
  DocumentService,
  filterByAccessContext,
  InMemoryDatabaseAdapter,
  type Memory,
  MemoryType,
  Role,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { maybeAugmentChatMessageWithDocuments } from "./chat-augmentation.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000ff" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;
const OWNER_ENTITY = "00000000-0000-0000-0000-00000000bbbb" as UUID;
const USER_ENTITY = "00000000-0000-0000-0000-00000000dddd" as UUID;
const DOCUMENT_ID = "00000000-0000-0000-0000-00000000d001" as UUID;

const SECRET_TEXT = "the denver launch codeword is mallard";
const SECRET_QUERY = "denver launch codeword";

function ownerPrivateDocument(): Memory {
  const metadata: DocumentMemoryMetadata = {
    type: MemoryType.DOCUMENT,
    documentId: DOCUMENT_ID,
    source: "test",
    scope: "owner-private",
    addedBy: OWNER_ENTITY,
    addedByRole: "OWNER",
    documentRevision: 0,
  };
  return {
    id: DOCUMENT_ID,
    agentId: AGENT_ID,
    entityId: OWNER_ENTITY,
    roomId: ROOM_ID,
    worldId: WORLD_ID,
    content: { text: SECRET_TEXT },
    metadata,
  };
}

function ownerPrivateFragment(
  scope: DocumentFragmentMemoryMetadata["scope"] = "owner-private",
): Memory {
  const metadata: DocumentFragmentMemoryMetadata = {
    type: MemoryType.FRAGMENT,
    documentId: DOCUMENT_ID,
    scope,
    addedBy: OWNER_ENTITY,
    addedByRole: "OWNER",
    documentRevision: 0,
    position: 0,
    source: "test",
  };
  return {
    id: "00000000-0000-0000-0000-00000000f001" as UUID,
    agentId: AGENT_ID,
    entityId: OWNER_ENTITY,
    roomId: ROOM_ID,
    worldId: WORLD_ID,
    content: { text: SECRET_TEXT },
    metadata,
  };
}

/**
 * Persists the authorization-bearing parent and fragment through the same
 * adapter capability production document search requires.
 */
async function makeRuntime(fragments: Memory[]): Promise<{
  runtime: AgentRuntime;
  documents: DocumentService;
}> {
  const adapter = new InMemoryDatabaseAdapter();
  await adapter.initialize();
  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character: {
      name: "DocumentAugmentationAuthorization",
      bio: ["Exercises requester-scoped document augmentation."],
      settings: {},
    },
    adapter,
    logLevel: "fatal",
  });
  await adapter.createWorlds([
    {
      id: WORLD_ID,
      agentId: AGENT_ID,
      name: "authorization world",
      metadata: {
        roles: {
          [OWNER_ENTITY]: Role.OWNER,
          [USER_ENTITY]: Role.MEMBER,
        },
        roleSources: { [OWNER_ENTITY]: "manual", [USER_ENTITY]: "manual" },
      },
    },
  ]);
  await adapter.createRooms([
    {
      id: ROOM_ID,
      agentId: AGENT_ID,
      source: "test",
      type: ChannelType.GROUP,
      worldId: WORLD_ID,
    },
  ]);
  await adapter.createRoomParticipants(
    [AGENT_ID, OWNER_ENTITY, USER_ENTITY],
    ROOM_ID,
  );
  await runtime.createMemories([
    { memory: ownerPrivateDocument(), tableName: "documents" },
    ...fragments.map((memory) => ({
      memory,
      tableName: "document_fragments",
    })),
  ]);

  const documents = new DocumentService(runtime);
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

describe("chat augmentation derives document access from the requester", () => {
  it("augments for the owner but not another room participant", async () => {
    const owner = await makeRuntime([ownerPrivateFragment()]);
    const ownerResult = await maybeAugmentChatMessageWithDocuments(
      owner.runtime,
      chatMessage(OWNER_ENTITY),
    );
    const ownerText = (ownerResult.content as { text?: string }).text ?? "";
    expect(ownerText).toContain(SECRET_TEXT);
    expect(ownerText).toContain("<contextual_documents>");

    const user = await makeRuntime([ownerPrivateFragment()]);
    const userMessage = chatMessage(USER_ENTITY);
    const userResult = await maybeAugmentChatMessageWithDocuments(
      user.runtime,
      userMessage,
    );
    const userText = (userResult.content as { text?: string }).text ?? "";
    expect(userText).not.toContain(SECRET_TEXT);
    expect(userText).not.toContain("<contextual_documents>");
    expect(userResult).toBe(userMessage);
  });

  it("uses the message requester for direct document searches", async () => {
    const { documents } = await makeRuntime([ownerPrivateFragment()]);

    const ownerHits = await documents.searchDocuments(
      chatMessage(OWNER_ENTITY),
      { roomId: ROOM_ID },
      "keyword",
    );
    expect(ownerHits.map((hit) => hit.content.text)).toContain(SECRET_TEXT);

    const userHits = await documents.searchDocuments(
      chatMessage(USER_ENTITY),
      { roomId: ROOM_ID },
      "keyword",
    );
    expect(userHits.map((hit) => hit.content.text)).not.toContain(SECRET_TEXT);
  });

  it("authorizes delegated searches from the parent before ranking", async () => {
    const { documents } = await makeRuntime([ownerPrivateFragment("global")]);
    const agentMessage = {
      ...chatMessage(USER_ENTITY),
      entityId: AGENT_ID,
    } as unknown as Memory;

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
    expect(userHits).toEqual([]);

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
    expect(ownerHits.map((hit) => hit.content.text)).toContain(SECRET_TEXT);
  });

  it.each(["", "   "])(
    "fails closed for an unauthenticated requester %j",
    async (entityId) => {
      const { runtime } = await makeRuntime([ownerPrivateFragment()]);
      const blankRequester = {
        ...chatMessage(USER_ENTITY),
        entityId,
      } as unknown as ReturnType<typeof createMessageMemory>;

      const result = await maybeAugmentChatMessageWithDocuments(
        runtime,
        blankRequester,
      );
      const text = (result.content as { text?: string }).text ?? "";
      expect(text).not.toContain(SECRET_TEXT);
      expect(text).not.toContain("<contextual_documents>");
      expect(result).toBe(blankRequester);
    },
  );

  it("keeps the generic access filter aligned with document scope semantics", () => {
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

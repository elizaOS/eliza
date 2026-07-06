/**
 * Presence bridge tests for passive relationship recency. The service listens
 * to runtime message events, so the test drives the registered handler and
 * verifies both the activity signal and relationship/contact recency writes.
 */
import {
  EventType,
  type IAgentRuntime,
  type MessagePayload,
  type UUID,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const entityStore = {
    observeIdentity: vi.fn(),
    recordInteraction: vi.fn(),
  };
  const relationshipStore = {
    get: vi.fn(),
    observe: vi.fn(),
  };
  return {
    activitySignals: [] as Array<Record<string, unknown>>,
    entityStore,
    relationshipStore,
  };
});

vi.mock("../lifeops/repository.js", () => ({
  createLifeOpsActivitySignal: (params: Record<string, unknown>) => ({
    ...params,
    id: "signal-1",
    createdAt: "2026-06-01T12:00:01.000Z",
  }),
  LifeOpsRepository: class LifeOpsRepository {
    async createActivitySignal(signal: Record<string, unknown>): Promise<void> {
      mockState.activitySignals.push(signal);
    }

    async entityStore(): Promise<typeof mockState.entityStore> {
      return mockState.entityStore;
    }

    async relationshipStore(): Promise<typeof mockState.relationshipStore> {
      return mockState.relationshipStore;
    }
  },
}));

import { PresenceSignalBridgeService } from "./presence-signal-bridge-service.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const CONTACT_ID = "10000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "20000000-0000-0000-0000-000000000001" as UUID;

function runtimeWithRelationships(relationshipsService: unknown): {
  runtime: IAgentRuntime;
  handlers: Map<string, (payload: MessagePayload) => Promise<void>>;
} {
  const handlers = new Map<
    string,
    (payload: MessagePayload) => Promise<void>
  >();
  const runtime = {
    agentId: AGENT_ID,
    getService: vi.fn((name: string) =>
      name === "relationships" ? relationshipsService : null,
    ),
    registerEvent: vi.fn(
      (event: string, handler: (payload: MessagePayload) => Promise<void>) => {
        handlers.set(event, handler);
      },
    ),
    unregisterEvent: vi.fn(),
  } as unknown as IAgentRuntime;
  return { runtime, handlers };
}

function messagePayload(
  overrides: Partial<MessagePayload> = {},
): MessagePayload {
  return {
    runtime: {} as IAgentRuntime,
    source: "telegram",
    message: {
      id: "30000000-0000-0000-0000-000000000001",
      entityId: CONTACT_ID,
      roomId: ROOM_ID,
      agentId: AGENT_ID,
      content: {
        text: "Sent the check-in",
        source: "telegram",
        channelType: "telegram",
      },
      createdAt: Date.parse("2026-06-01T12:00:00.000Z"),
      metadata: {
        originalId: "telegram-message-1",
        sender: { username: "priya" },
      },
    },
    ...overrides,
  } as unknown as MessagePayload;
}

describe("PresenceSignalBridgeService relationship recency", () => {
  beforeEach(() => {
    mockState.activitySignals.length = 0;
    vi.clearAllMocks();
    mockState.relationshipStore.get.mockResolvedValue({
      relationshipId: `lifeops-contact-${CONTACT_ID}`,
      type: "contact",
    });
  });

  it("records core contact and graph recency for owner-sent connector messages", async () => {
    const relationshipsService = {
      findByHandle: vi.fn(async () => ({ entityId: CONTACT_ID })),
      getContact: vi.fn(async () => ({ entityId: CONTACT_ID })),
      recordInteraction: vi.fn(),
    };
    const { runtime, handlers } =
      runtimeWithRelationships(relationshipsService);
    await PresenceSignalBridgeService.start(runtime);

    await handlers.get(EventType.MESSAGE_SENT)?.(messagePayload());

    expect(mockState.activitySignals[0]).toMatchObject({
      source: "connector_activity",
      platform: "telegram",
      observedAt: "2026-06-01T12:00:00.000Z",
    });
    expect(relationshipsService.recordInteraction).toHaveBeenCalledWith({
      contactId: CONTACT_ID,
      platform: "telegram",
      direction: "outbound",
      summary: "Passive telegram message activity",
      externalRef: "telegram-message-1",
      occurredAt: "2026-06-01T12:00:00.000Z",
    });
    expect(mockState.entityStore.recordInteraction).toHaveBeenCalledWith(
      CONTACT_ID,
      {
        platform: "telegram",
        direction: "outbound",
        summary: "Passive telegram message activity",
        occurredAt: "2026-06-01T12:00:00.000Z",
      },
    );
    expect(mockState.relationshipStore.observe).toHaveBeenCalledWith({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: CONTACT_ID,
      type: "contact",
      metadataPatch: {
        lastInteractionPlatform: "telegram",
        lastInteractionDirection: "outbound",
      },
      evidence: ["lifeops:contact", "message_ingest"],
      confidence: 0.8,
      occurredAt: "2026-06-01T12:00:00.000Z",
      source: "extraction",
    });
    expect(mockState.entityStore.observeIdentity).not.toHaveBeenCalled();
  });

  it("uses identity observation when only a connector handle is known", async () => {
    const relationshipsService = {
      getContact: vi.fn(async () => null),
    };
    mockState.entityStore.observeIdentity.mockResolvedValue({
      entity: { entityId: CONTACT_ID },
    });
    mockState.relationshipStore.get.mockResolvedValue(null);
    const { runtime, handlers } =
      runtimeWithRelationships(relationshipsService);
    await PresenceSignalBridgeService.start(runtime);

    await handlers.get(EventType.MESSAGE_RECEIVED)?.(
      messagePayload({
        message: {
          ...messagePayload().message,
          entityId: "10000000-0000-0000-0000-000000000099" as UUID,
        },
      }),
    );

    expect(mockState.entityStore.observeIdentity).toHaveBeenCalledWith({
      platform: "telegram",
      handle: "priya",
      evidence: ["lifeops:contact", "message_ingest"],
      confidence: 0.8,
      suggestedType: "person",
    });
    expect(mockState.entityStore.recordInteraction).toHaveBeenCalledWith(
      CONTACT_ID,
      expect.objectContaining({ direction: "inbound" }),
    );
  });

  it("does not dedupe same-timestamp handle-only messages for different contacts", async () => {
    const morganId = "10000000-0000-0000-0000-000000000002" as UUID;
    const relationshipsService = {
      getContact: vi.fn(async () => null),
    };
    mockState.entityStore.observeIdentity.mockImplementation(
      async ({ handle }: { handle: string }) => ({
        entity: { entityId: handle === "morgan" ? morganId : CONTACT_ID },
      }),
    );
    mockState.relationshipStore.get.mockResolvedValue(null);
    const { runtime, handlers } =
      runtimeWithRelationships(relationshipsService);
    await PresenceSignalBridgeService.start(runtime);

    await handlers.get(EventType.MESSAGE_RECEIVED)?.(
      messagePayload({
        message: {
          ...messagePayload().message,
          entityId: undefined,
        },
      }),
    );
    await handlers.get(EventType.MESSAGE_RECEIVED)?.(
      messagePayload({
        message: {
          ...messagePayload().message,
          entityId: undefined,
          id: "30000000-0000-0000-0000-000000000002",
          metadata: {
            originalId: "telegram-message-2",
            sender: { username: "morgan" },
          },
        },
      }),
    );

    expect(mockState.activitySignals).toHaveLength(2);
    expect(mockState.entityStore.observeIdentity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ handle: "priya" }),
    );
    expect(mockState.entityStore.observeIdentity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ handle: "morgan" }),
    );
    expect(mockState.entityStore.recordInteraction).toHaveBeenCalledWith(
      CONTACT_ID,
      expect.objectContaining({ direction: "inbound" }),
    );
    expect(mockState.entityStore.recordInteraction).toHaveBeenCalledWith(
      morganId,
      expect.objectContaining({ direction: "inbound" }),
    );
  });

  it("records iMessage outbound events that carry the owner entity and recipient handle", async () => {
    const relationshipsService = {
      findByHandle: vi.fn(async () => ({ entityId: CONTACT_ID })),
      getContact: vi.fn(async () => null),
      recordInteraction: vi.fn(),
    };
    const { runtime, handlers } =
      runtimeWithRelationships(relationshipsService);
    await PresenceSignalBridgeService.start(runtime);

    await handlers.get(EventType.MESSAGE_SENT)?.(
      messagePayload({
        source: "imessage",
        message: {
          ...messagePayload().message,
          entityId: AGENT_ID,
          content: { text: "On it", source: "imessage" },
          metadata: {
            originalId: "imessage-message-1",
            imessage: { chatId: "+15555550123" },
          },
        },
      }),
    );

    expect(relationshipsService.findByHandle).toHaveBeenCalledWith(
      "imessage",
      "+15555550123",
    );
    expect(relationshipsService.recordInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: CONTACT_ID,
        platform: "imessage",
        direction: "outbound",
        externalRef: "imessage-message-1",
      }),
    );
    expect(mockState.relationshipStore.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        toEntityId: CONTACT_ID,
        metadataPatch: {
          lastInteractionPlatform: "imessage",
          lastInteractionDirection: "outbound",
        },
      }),
    );
  });
});

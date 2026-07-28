/**
 * Integration coverage for the LifeOps audience egress gate.
 *
 * A real PGlite-backed AgentRuntime owns room, participant, and role metadata;
 * the only seam is a canary-bearing loader used after the exported provider
 * gate, proving denied destinations are filtered before private context can be
 * read or composed for a model prompt.
 */
import {
  AgentRuntime,
  ChannelType,
  type Character,
  createMessageMemory,
  type Memory,
  type UUID,
} from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DatabaseMigrationService } from "../../../plugin-sql/src/migration-service.js";
import { PgliteDatabaseAdapter } from "../../../plugin-sql/src/pglite/adapter.js";
import { PGliteClientManager } from "../../../plugin-sql/src/pglite/manager.js";
import * as schema from "../../../plugin-sql/src/schema/index.js";
import type { DrizzleDatabase } from "../../../plugin-sql/src/types.js";
import {
  lifeOpsProvider,
  resolveLifeOpsProviderAudienceGate,
} from "../providers/lifeops.js";
import {
  evaluateLifeOpsAudiencePolicy,
  type LifeOpsAudienceGateResult,
  type LifeOpsAudienceReason,
  type LifeOpsAudienceSource,
} from "./audience-policy.js";
import { LifeOpsService } from "./service.js";

const OWNER_CANARY = "OWNER_SECRET_CORPUS_ALPINE_7421";
const LEAK_CORPUS = {
  gmail: "GMAIL_CANARY_INBOX_QUARTZ_8123",
  calendar: "CALENDAR_CANARY_EVENT_ONYX_4772",
  privateMemory: "PRIVATE_MEMORY_CANARY_VAULT_1936",
} as const;
const AGENT_PERSONA = "persona-alpha";
const OTHER_PERSONA = "persona-beta";

const PRIVATE_SOURCE: LifeOpsAudienceSource = {
  kind: "private_memory",
  id: "private-canary",
  classification: "persona_scoped",
  persona: AGENT_PERSONA,
};

const PUBLIC_SOURCE: LifeOpsAudienceSource = {
  kind: "public_memory",
  id: "public-release-note",
  classification: "public",
  persona: null,
};

const CROSS_PERSONA_CALENDAR_SOURCE: LifeOpsAudienceSource = {
  kind: "calendar",
  id: "calendar-beta",
  classification: "persona_scoped",
  persona: OTHER_PERSONA,
};

const CROSS_PERSONA_GMAIL_SOURCE: LifeOpsAudienceSource = {
  kind: "gmail",
  id: "gmail-beta",
  classification: "persona_scoped",
  persona: OTHER_PERSONA,
};

async function loadAfterGate(
  gate: LifeOpsAudienceGateResult,
  loader: () => Promise<string>,
): Promise<string> {
  return gate.canLoadPrivateContext ? loader() : "";
}

function uuid(): UUID {
  return crypto.randomUUID() as UUID;
}

function message(args: {
  entityId: UUID;
  roomId: UUID;
  channelType: ChannelType;
  requestingPersona?: string;
  persona?: string;
}): Memory {
  return createMessageMemory({
    id: uuid(),
    entityId: args.entityId,
    roomId: args.roomId,
    content: {
      text: "read my LifeOps context",
      source: "test",
      channelType: args.channelType,
      ...(args.requestingPersona
        ? { requestingPersona: args.requestingPersona }
        : {}),
      ...(args.persona ? { persona: args.persona } : {}),
    },
  });
}

describe("LifeOps audience policy (real runtime + PGlite)", () => {
  let manager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let ownerId: UUID;
  let otherId: UUID;
  let outsiderId: UUID;
  let worldId: UUID;

  beforeAll(async () => {
    ownerId = uuid();
    otherId = uuid();
    outsiderId = uuid();
    const agentId = uuid();
    manager = new PGliteClientManager({});
    await manager.initialize();
    adapter = new PgliteDatabaseAdapter(agentId, manager);
    await adapter.init();
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(
      adapter.getDatabase() as DrizzleDatabase,
    );
    migrationService.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrationService.runAllPluginMigrations();
    await adapter.createAgent({
      id: agentId,
      name: AGENT_PERSONA,
      bio: ["Test audience-policy agent"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    runtime = new AgentRuntime({
      agentId,
      character: {
        id: agentId,
        name: AGENT_PERSONA,
      } as Character,
      adapter,
    });
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId, false);
    worldId = uuid();
    await runtime.ensureWorldExists({
      id: worldId,
      name: "audience-policy-world",
      agentId: runtime.agentId,
    } as Parameters<typeof runtime.ensureWorldExists>[0]);
    for (const entityId of [
      runtime.agentId as UUID,
      ownerId,
      otherId,
      outsiderId,
    ]) {
      await runtime.createEntity({
        id: entityId,
        names: [entityId],
        agentId: runtime.agentId,
      });
    }
  }, 180_000);

  afterAll(async () => {
    await adapter?.close();
    await manager?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function ensureRoom(args: {
    type: ChannelType;
    participants: UUID[];
  }): Promise<UUID> {
    const roomId = uuid();
    await runtime.createRoom({
      id: roomId,
      name: `room-${roomId}`,
      source: "test",
      type: args.type,
      channelId: roomId,
      worldId,
    });
    for (const participant of args.participants) {
      await runtime.ensureParticipantInRoom(participant, roomId);
    }
    return roomId;
  }

  async function expectReason(args: {
    roomId: UUID;
    requester: UUID;
    messageType: ChannelType;
    source?: LifeOpsAudienceSource;
    reason: LifeOpsAudienceReason;
    decision?: "include" | "exclude";
    requestingPersona?: string;
  }) {
    const gate = await evaluateLifeOpsAudiencePolicy({
      runtime,
      message: message({
        entityId: args.requester,
        roomId: args.roomId,
        channelType: args.messageType,
        requestingPersona: args.requestingPersona ?? AGENT_PERSONA,
      }),
      sources: [args.source ?? PRIVATE_SOURCE],
      hasOwnerAccess: async (_runtime, request) => request.entityId === ownerId,
    });
    expect(gate.receipts).toHaveLength(1);
    expect(gate.receipts[0]).toMatchObject({
      decision: args.decision ?? "exclude",
      reason: args.reason,
      requestEntityId: args.requester,
      destinationRoomId: args.roomId,
    });
    expect(gate.receipts[0].participantEntityIds).toEqual(
      [...gate.receipts[0].participantEntityIds].sort(),
    );
    return gate;
  }

  function wrapRuntime(
    overrides: Partial<
      Pick<AgentRuntime, "getRoom" | "getParticipantsForRoom">
    >,
  ): AgentRuntime {
    const wrapped = Object.create(runtime) as AgentRuntime;
    Object.assign(wrapped, overrides);
    return wrapped;
  }

  it("allows owner DM private context and returns an inclusion receipt", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    const gate = await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.DM,
      reason: "included_private_dm",
      decision: "include",
    });
    let reads = 0;
    const text = await loadAfterGate(gate, async () => {
      reads += 1;
      return OWNER_CANARY;
    });
    expect(reads).toBe(1);
    expect(text).toBe(OWNER_CANARY);
  });

  it("allows public memory in an owner DM with an explicit public-DM receipt", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.DM,
      source: PUBLIC_SOURCE,
      reason: "included_public_dm",
      decision: "include",
    });
  });

  it("denies owner private context in groups before loader or provider reads", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.GROUP,
      participants: [runtime.agentId as UUID, ownerId, otherId],
    });
    const gate = await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.GROUP,
      reason: "excluded_group_destination",
    });
    let reads = 0;
    const text = await loadAfterGate(gate, async () => {
      reads += 1;
      return Object.values(LEAK_CORPUS).join("\n");
    });
    expect(reads).toBe(0);
    for (const canary of Object.values(LEAK_CORPUS)) {
      expect(text).not.toContain(canary);
    }

    const overviewSpy = vi
      .spyOn(LifeOpsService.prototype, "getOverview")
      .mockRejectedValue(new Error(LEAK_CORPUS.privateMemory));
    const calendarSpy = vi
      .spyOn(LifeOpsService.prototype, "getNextCalendarEventContext")
      .mockRejectedValue(new Error(LEAK_CORPUS.calendar));
    const gmailSpy = vi
      .spyOn(LifeOpsService.prototype, "getGmailTriage")
      .mockRejectedValue(new Error(LEAK_CORPUS.gmail));

    const providerResult = await lifeOpsProvider.get(
      runtime,
      message({
        entityId: ownerId,
        roomId,
        channelType: ChannelType.GROUP,
        requestingPersona: AGENT_PERSONA,
      }),
      { values: {}, data: {}, text: "" },
    );
    expect(overviewSpy).not.toHaveBeenCalled();
    expect(calendarSpy).not.toHaveBeenCalled();
    expect(gmailSpy).not.toHaveBeenCalled();
    const serializedProviderResult = JSON.stringify(providerResult);
    for (const canary of Object.values(LEAK_CORPUS)) {
      expect(providerResult.text).not.toContain(canary);
      expect(serializedProviderResult).not.toContain(canary);
    }
    expect(providerResult.text).not.toContain("Owner profile:");
    expect(providerResult.text).not.toContain("Inbox:");
    expect(providerResult.text).not.toContain("Next event:");
    expect(providerResult.data?.lifeOpsAudienceReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "exclude",
          reason: "excluded_group_destination",
        }),
      ]),
    );
  });

  it("denies missing room metadata", async () => {
    await expectReason({
      roomId: uuid(),
      requester: ownerId,
      messageType: ChannelType.DM,
      reason: "excluded_missing_room",
    });
  });

  it("distinguishes room metadata lookup failures without leaking exception payloads", async () => {
    const roomId = uuid();
    const failureCanary = "ROOM_LOOKUP_FAILURE_PAYLOAD_EMERALD_6331";
    const gate = await evaluateLifeOpsAudiencePolicy({
      runtime: wrapRuntime({
        getRoom: async () => {
          throw new Error(failureCanary);
        },
      }),
      message: message({
        entityId: ownerId,
        roomId,
        channelType: ChannelType.DM,
      }),
      sources: [PRIVATE_SOURCE],
      hasOwnerAccess: async (_runtime, request) => request.entityId === ownerId,
    });
    expect(gate.receipts[0]).toMatchObject({
      decision: "exclude",
      reason: "excluded_metadata_lookup_failed",
      destinationRoomType: null,
      participantEntityIds: [],
    });
    expect(JSON.stringify(gate)).not.toContain(failureCanary);
  });

  it("denies missing or empty participant metadata", async () => {
    const roomId = await ensureRoom({ type: ChannelType.DM, participants: [] });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.DM,
      reason: "excluded_missing_participants",
    });
  });

  it("distinguishes participant metadata lookup failures without leaking exception payloads", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    const failureCanary = "PARTICIPANT_LOOKUP_FAILURE_PAYLOAD_TOPAZ_9214";
    const gate = await evaluateLifeOpsAudiencePolicy({
      runtime: wrapRuntime({
        getParticipantsForRoom: async () => {
          throw new Error(failureCanary);
        },
      }),
      message: message({
        entityId: ownerId,
        roomId,
        channelType: ChannelType.DM,
      }),
      sources: [PRIVATE_SOURCE],
      hasOwnerAccess: async (_runtime, request) => request.entityId === ownerId,
    });
    expect(gate.receipts[0]).toMatchObject({
      decision: "exclude",
      reason: "excluded_metadata_lookup_failed",
      destinationRoomType: ChannelType.DM,
      participantEntityIds: [],
    });
    expect(JSON.stringify(gate)).not.toContain(failureCanary);
  });

  it("denies null-ish participant responses", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    const gate = await evaluateLifeOpsAudiencePolicy({
      runtime: wrapRuntime({
        getParticipantsForRoom: async () => null as unknown as UUID[],
      }),
      message: message({
        entityId: ownerId,
        roomId,
        channelType: ChannelType.DM,
      }),
      sources: [PRIVATE_SOURCE],
      hasOwnerAccess: async (_runtime, request) => request.entityId === ownerId,
    });
    expect(gate.receipts[0]).toMatchObject({
      decision: "exclude",
      reason: "excluded_missing_participants",
    });
  });

  it("denies stale private participant sets", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId, otherId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.DM,
      reason: "excluded_unexpected_participants",
    });
  });

  it("denies private destinations when the agent is not an authoritative participant", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [ownerId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.DM,
      reason: "excluded_agent_not_participant",
    });
  });

  it("denies cross-persona sources without hardcoded names", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.DM,
      source: { ...PRIVATE_SOURCE, persona: OTHER_PERSONA },
      requestingPersona: AGENT_PERSONA,
      reason: "excluded_cross_persona",
    });
  });

  it("does not let message content spoof the authoritative requesting persona", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    const gate = await evaluateLifeOpsAudiencePolicy({
      runtime,
      message: message({
        entityId: ownerId,
        roomId,
        channelType: ChannelType.DM,
        requestingPersona: OTHER_PERSONA,
        persona: OTHER_PERSONA,
      }),
      sources: [{ ...PRIVATE_SOURCE, persona: OTHER_PERSONA }],
      hasOwnerAccess: async (_runtime, request) => request.entityId === ownerId,
    });
    expect(gate.receipts[0]).toMatchObject({
      decision: "exclude",
      reason: "excluded_cross_persona",
      requestingPersona: AGENT_PERSONA,
    });
    expect(gate.canLoadPrivateContext).toBe(false);
  });

  it("allows explicitly public memory in an authoritative group", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.GROUP,
      participants: [runtime.agentId as UUID, ownerId, otherId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.GROUP,
      source: PUBLIC_SOURCE,
      reason: "included_public_group",
      decision: "include",
    });
    const gate = await resolveLifeOpsProviderAudienceGate(
      runtime,
      message({
        entityId: ownerId,
        roomId,
        channelType: ChannelType.GROUP,
        requestingPersona: AGENT_PERSONA,
      }),
      [PUBLIC_SOURCE],
    );
    expect(gate.canLoadPrivateContext).toBe(false);
  });

  it("denies explicitly public group memory when the agent is not an authoritative participant", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.GROUP,
      participants: [ownerId, otherId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.GROUP,
      source: PUBLIC_SOURCE,
      reason: "excluded_agent_not_participant",
    });
  });

  it("keeps bundled private context closed when any requested private source is denied", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    const gate = await evaluateLifeOpsAudiencePolicy({
      runtime,
      message: message({
        entityId: ownerId,
        roomId,
        channelType: ChannelType.DM,
        requestingPersona: AGENT_PERSONA,
      }),
      sources: [
        PRIVATE_SOURCE,
        CROSS_PERSONA_CALENDAR_SOURCE,
        CROSS_PERSONA_GMAIL_SOURCE,
      ],
      hasOwnerAccess: async (_runtime, request) => request.entityId === ownerId,
    });
    expect(gate.canLoadPrivateContext).toBe(false);
    expect(gate.receipts.map((receipt) => receipt.reason)).toEqual([
      "included_private_dm",
      "excluded_cross_persona",
      "excluded_cross_persona",
    ]);
    let reads = 0;
    const text = await loadAfterGate(gate, async () => {
      reads += 1;
      return Object.values(LEAK_CORPUS).join("\n");
    });
    expect(reads).toBe(0);
    for (const canary of Object.values(LEAK_CORPUS)) {
      expect(text).not.toContain(canary);
    }
  });

  it("denies when the requester is not a room participant", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.GROUP,
      participants: [runtime.agentId as UUID, otherId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.GROUP,
      reason: "excluded_requester_not_participant",
    });
  });

  it("denies channel-type mismatch between message and stored room", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.GROUP,
      reason: "excluded_channel_type_mismatch",
    });
  });

  it("does not let SELF or API message types relax mismatched stored room metadata", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, ownerId],
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.SELF,
      reason: "excluded_channel_type_mismatch",
    });
    await expectReason({
      roomId,
      requester: ownerId,
      messageType: ChannelType.API,
      reason: "excluded_channel_type_mismatch",
    });
  });

  it("denies non-owner requesters with receipts", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.DM,
      participants: [runtime.agentId as UUID, otherId],
    });
    await expectReason({
      roomId,
      requester: otherId,
      messageType: ChannelType.DM,
      reason: "excluded_non_owner_requester",
    });
  });

  it("uses the same exported gate as the live provider", async () => {
    const roomId = await ensureRoom({
      type: ChannelType.GROUP,
      participants: [runtime.agentId as UUID, ownerId, otherId],
    });
    const gate = await resolveLifeOpsProviderAudienceGate(
      runtime,
      message({
        entityId: ownerId,
        roomId,
        channelType: ChannelType.GROUP,
        requestingPersona: AGENT_PERSONA,
      }),
    );
    expect(gate.canLoadPrivateContext).toBe(false);
    expect(gate.receipts.map((receipt) => receipt.reason)).toEqual([
      "excluded_group_destination",
      "excluded_group_destination",
      "excluded_group_destination",
    ]);
  });
});

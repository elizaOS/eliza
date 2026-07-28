/**
 * Production-path integration coverage for audience-scoped private context.
 *
 * Uses the real PGlite AgentRuntime, provider/action implementations and core
 * pipeline-hook delivery registry.  No canary loader wrapper is used: denied
 * reads are asserted at the provider/action entrypoints that production calls.
 */
import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Content,
  createMessageMemory,
  outgoingPipelineHookContext,
  type State,
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
import { calendarAction } from "../actions/calendar.js";
import { crossChannelContextProvider } from "../providers/cross-channel-context.js";
import { lifeOpsProvider } from "../providers/lifeops.js";
import { pendingApprovalsProvider } from "../providers/pending-approvals.js";
import {
  authorizeLifeOpsPrivateContext,
  evaluateLifeOpsAudiencePolicy,
  registerLifeOpsAudienceDeliveryHook,
} from "./audience-policy.js";
import { LifeOpsService } from "./service.js";

const AGENT_DISPLAY_NAME = "mutable-display-name";
const PRIVATE_SOURCES = [
  { kind: "private_memory" as const, id: "owner-memory" },
  { kind: "calendar" as const, id: "owner-calendar" },
  { kind: "gmail" as const, id: "owner-gmail" },
];
const EMPTY_STATE: State = { text: "", values: {}, data: {} };

function uuid(): UUID {
  return crypto.randomUUID() as UUID;
}

describe("shared LifeOps audience boundary (production provider/action paths)", () => {
  let manager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let ownerId: UUID;
  let otherId: UUID;
  let worldId: UUID;

  beforeAll(async () => {
    ownerId = uuid();
    otherId = uuid();
    const agentId = uuid();
    manager = new PGliteClientManager({});
    await manager.initialize();
    adapter = new PgliteDatabaseAdapter(agentId, manager);
    await adapter.init();
    const migrations = new DatabaseMigrationService();
    await migrations.initializeWithDatabase(
      adapter.getDatabase() as DrizzleDatabase,
    );
    migrations.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrations.runAllPluginMigrations();
    await adapter.createAgent({
      id: agentId,
      name: "persisted-loader-identity",
      bio: ["Audience integration agent"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    runtime = new AgentRuntime({
      agentId,
      character: {
        id: agentId,
        name: AGENT_DISPLAY_NAME,
      } as Character,
      adapter,
    });
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId, false);
    worldId = uuid();
    await runtime.ensureWorldExists({
      id: worldId,
      name: "audience-world",
      agentId,
      metadata: { ownership: { ownerId } },
    });
    for (const entityId of [agentId, ownerId, otherId]) {
      await runtime.createEntity({
        id: entityId,
        names: [entityId],
        agentId,
      });
    }
    registerLifeOpsAudienceDeliveryHook(runtime);
  }, 180_000);

  afterAll(async () => {
    await adapter?.close();
    await manager?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runtime.character.name = AGENT_DISPLAY_NAME;
  });

  async function room(type: ChannelType, participants: UUID[]): Promise<UUID> {
    const roomId = uuid();
    await runtime.createRoom({
      id: roomId,
      name: `room-${roomId}`,
      source: "test",
      type,
      channelId: roomId,
      worldId,
    });
    for (const participant of participants) {
      await runtime.ensureParticipantInRoom(participant, roomId);
    }
    return roomId;
  }

  function message(
    roomId: UUID,
    channelType: ChannelType,
    text = "owner request",
  ) {
    return createMessageMemory({
      id: uuid(),
      entityId: ownerId,
      agentId: runtime.agentId,
      roomId,
      content: { text, source: "test", channelType },
    });
  }

  it.each([
    [ChannelType.DM, ChannelType.DM],
    // Production web/OpenAI/Anthropic compatibility routes persist DM rooms
    // while stamping their messages API. Both belong to one private class.
    [ChannelType.DM, ChannelType.API],
    [ChannelType.DM, ChannelType.VOICE_DM],
    [ChannelType.SELF, ChannelType.SELF],
  ])(
    "allows private stored room %s with private message surface %s",
    async (roomType, messageType) => {
      const roomId = await room(roomType, [runtime.agentId, ownerId]);
      const gate = await authorizeLifeOpsPrivateContext({
        runtime,
        message: message(roomId, messageType),
        sources: PRIVATE_SOURCES,
      });
      expect(gate.canLoadPrivateContext).toBe(true);
      expect(gate.receipts.every((row) => row.decision === "include")).toBe(
        true,
      );
      expect(gate.receipts[0]).toMatchObject({
        roomAudienceClass: "private",
        messageAudienceClass: "private",
        reason: "included_private_audience",
        source: { trustedAgentId: runtime.agentId },
      });
    },
  );

  it("binds provenance to the persisted agent id, ignoring mutable display/message persona", async () => {
    const roomId = await room(ChannelType.DM, [runtime.agentId, ownerId]);
    const request = message(roomId, ChannelType.API);
    request.content.requestingPersona = "attacker-selected-persona";
    runtime.character.name = "changed-after-loader-start";
    const gate = await authorizeLifeOpsPrivateContext({
      runtime,
      message: request,
      sources: [{ kind: "gmail", id: "loader-selected-account" }],
    });
    expect(gate.canLoadPrivateContext).toBe(true);
    expect(gate.receipts[0].source.trustedAgentId).toBe(runtime.agentId);
    expect(JSON.stringify(gate.receipts)).not.toContain(
      "attacker-selected-persona",
    );
    expect(JSON.stringify(gate.receipts)).not.toContain(
      "changed-after-loader-start",
    );
  });

  it("denies all private provider retrieval paths in a group before their loaders run", async () => {
    const roomId = await room(ChannelType.GROUP, [
      runtime.agentId,
      ownerId,
      otherId,
    ]);
    const request = message(roomId, ChannelType.GROUP);

    const overview = vi.spyOn(LifeOpsService.prototype, "getOverview");
    const lifeOps = await lifeOpsProvider.get(runtime, request, EMPTY_STATE);
    expect(overview).not.toHaveBeenCalled();
    expect(lifeOps.text).toBe("");
    expect(lifeOps.data?.lifeOpsAudienceReceipts).toBeDefined();

    const crossChannel = await crossChannelContextProvider.get(
      runtime,
      request,
      {
        ...EMPTY_STATE,
        crossChannelContextRequest: { query: "secret gmail project" },
      } as State,
    );
    expect(crossChannel.text).toBe("");
    expect(crossChannel.values?.crossChannelUnavailable).toBe(true);
    expect(crossChannel.data?.lifeOpsAudienceReceipts).toBeDefined();

    const approvals = await pendingApprovalsProvider.get(
      runtime,
      request,
      EMPTY_STATE,
    );
    expect(approvals.text).toBe("");
    expect(approvals.values?.pendingApprovalsUnavailable).toBe(true);
    expect(approvals.data?.lifeOpsAudienceReceipts).toBeDefined();
  });

  it("denies the real calendar action path in a group without delivering detail", async () => {
    const roomId = await room(ChannelType.GROUP, [
      runtime.agentId,
      ownerId,
      otherId,
    ]);
    const callback = vi.fn(async (_content: Content) => []);
    const result = await calendarAction.handler(
      runtime,
      message(roomId, ChannelType.GROUP, "show my calendar"),
      EMPTY_STATE,
      { parameters: { action: "feed" } },
      callback,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      data: { error: "AUDIENCE_DENIED" },
    });
  });

  it("revalidates a real DB membership version at the production outgoing hook", async () => {
    const roomId = await room(ChannelType.DM, [runtime.agentId, ownerId]);
    const request = message(roomId, ChannelType.API);
    const gate = await authorizeLifeOpsPrivateContext({
      runtime,
      message: request,
      sources: PRIVATE_SOURCES,
    });
    expect(gate.canLoadPrivateContext).toBe(true);

    // Concurrent membership mutation after private retrieval authorization.
    await runtime.ensureParticipantInRoom(otherId, roomId);

    const deliver = vi.fn(async (_content: Content) => []);
    const content: Content = { text: "PRIVATE_CALENDAR_CANARY" };
    await runtime.applyPipelineHooks(
      "outgoing_before_deliver",
      outgoingPipelineHookContext(content, {
        source: "simple",
        roomId,
        message: request,
      }),
    );
    await deliver(content);
    expect(deliver).toHaveBeenCalledOnce();
    expect(content.text).toContain("delivery was cancelled");
    expect(content.text).not.toContain("PRIVATE_CALENDAR_CANARY");
  });

  it("revalidates membership before every streamed chunk delivery", async () => {
    const roomId = await room(ChannelType.DM, [runtime.agentId, ownerId]);
    const request = message(roomId, ChannelType.VOICE_DM);
    await authorizeLifeOpsPrivateContext({
      runtime,
      message: request,
      sources: [{ kind: "calendar", id: "voice.calendar" }],
    });
    await runtime.ensureParticipantInRoom(otherId, roomId);
    const streamContext = {
      phase: "model_stream_chunk" as const,
      source: "message_service" as const,
      chunk: "PRIVATE_VOICE_CANARY",
      roomId,
    };
    await runtime.applyPipelineHooks("model_stream_chunk", streamContext);
    expect(streamContext.chunk).toBe("");
  });

  it("reports authorization and metadata failures and fails closed", async () => {
    const roomId = await room(ChannelType.DM, [runtime.agentId, ownerId]);
    const reportError = vi.spyOn(runtime, "reportError");
    const broken = Object.create(runtime) as AgentRuntime;
    broken.getRoom = vi.fn(async () => {
      throw new Error("DB_AUTH_CANARY");
    });
    broken.reportError = runtime.reportError.bind(runtime);
    const gate = await evaluateLifeOpsAudiencePolicy({
      runtime: broken,
      message: message(roomId, ChannelType.DM),
      sources: PRIVATE_SOURCES,
      hasOwnerAccess: async () => {
        throw new Error("ROLE_AUTH_CANARY");
      },
    });
    expect(gate.canLoadPrivateContext).toBe(false);
    expect(gate.receipts[0].reason).toBe("excluded_non_owner_requester");
    expect(reportError).toHaveBeenCalledWith(
      "LifeOpsAudience.metadata",
      expect.any(Error),
      expect.any(Object),
    );
    expect(reportError).toHaveBeenCalledWith(
      "LifeOpsAudience.ownerAccess",
      expect.any(Error),
      expect.any(Object),
    );
    expect(JSON.stringify(gate.receipts)).not.toContain("DB_AUTH_CANARY");
    expect(JSON.stringify(gate.receipts)).not.toContain("ROLE_AUTH_CANARY");
  });
});

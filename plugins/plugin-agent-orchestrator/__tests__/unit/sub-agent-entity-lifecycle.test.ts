/**
 * Verifies the sub-agent entity lifecycle (#15102): every router post is
 * attributed to ONE shared per-agent entity (per-session identity lives on
 * each memory's content.metadata), and the legacy per-session entities that
 * earlier router versions minted are unlinked from room participants —
 * hidden from every entities-in-room consumer — without touching the entity
 * rows or the transcript memories that FK them. Deterministic harness (no
 * live model); the real-adapter FK/cascade semantics are pinned in
 * plugin-sql's sub-agent-entity-unlink.real.test.ts and plugin-inmemorydb's
 * participant-unlink contract test.
 */
import type { Entity, HandlerCallback, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  isLegacySubAgentEntityMetadata,
  SubAgentRouter,
} from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const ROOM = "11111111-2222-3333-4444-555555555555" as UUID;
const WORLD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const USER = "ffffffff-1111-2222-3333-444444444444" as UUID;
const PARENT_MSG = "99999999-8888-7777-6666-555555555555" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SESSION_A = "01234567-89ab-cdef-0123-456789abcdef";
const SESSION_B = "fedcba98-7654-3210-fedc-ba9876543210";

function makeSession(
  id: string,
  label: string,
  // Distinct per session by default: two sessions for the SAME origin message
  // are a retry lineage and the cross-session completion dedupe absorbs the
  // second post — these tests model two independent user requests.
  messageId: UUID = PARENT_MSG,
): SessionInfo {
  const now = new Date("2026-07-06T12:00:00.000Z");
  return {
    id,
    name: label,
    agentType: "codex",
    workdir: "/tmp/wf",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: {
      label,
      roomId: ROOM,
      worldId: WORLD,
      userId: USER,
      messageId,
      source: "telegram",
    },
  };
}

function makeAcp(sessions: SessionInfo[]): {
  service: Record<string, unknown>;
  emit: (sessionId: string, event: string, data: unknown) => void;
} {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const service = {
    onSessionEvent: vi.fn(
      (fn: (sessionId: string, event: string, data: unknown) => void) => {
        handler = fn;
        return () => {
          handler = undefined;
        };
      },
    ),
    stopSession: vi.fn(async () => {}),
    getSession: vi.fn(async (id: string) => byId.get(id) ?? null),
    listSessions: vi.fn(async () => sessions),
    updateSessionMetadata: vi.fn(async () => {}),
    getChangedPaths: vi.fn(() => [] as string[]),
    sendToSession: vi.fn(async () => ({})),
  };
  return {
    service,
    emit(sessionId, event, data) {
      handler?.(sessionId, event, data);
    },
  };
}

function makeRuntime(opts: {
  acp: unknown;
  roomEntities?: Entity[];
  deleteParticipantsImpl?: () => Promise<boolean>;
}) {
  const handleMessage = vi.fn<
    (
      runtime: unknown,
      memory: Memory,
      callback?: HandlerCallback,
    ) => Promise<unknown>
  >(async () => ({}));
  const createEntity = vi.fn(async () => true);
  const addParticipant = vi.fn(async () => true);
  const getEntitiesForRoom = vi.fn(async (_roomId: string) => [
    ...(opts.roomEntities ?? []),
  ]);
  const deleteParticipants = vi.fn(
    opts.deleteParticipantsImpl ?? (async () => true),
  );
  const reportError = vi.fn();
  const runtime = {
    agentId: AGENT_ID,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getService: vi.fn(() => opts.acp ?? null),
    getSetting: vi.fn(() => undefined),
    createMemory: vi.fn(async () => undefined),
    createEntity,
    addParticipant,
    getEntitiesForRoom,
    deleteParticipants,
    reportError,
    emitEvent: vi.fn(async () => undefined),
    messageService: { handleMessage },
  } as never;
  return {
    runtime,
    handleMessage,
    createEntity,
    addParticipant,
    getEntitiesForRoom,
    deleteParticipants,
    reportError,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/** The shared entityId is a private derivation; capture it through the same
 *  public behavior every consumer sees (the createEntity call). */
async function resolveSharedEntityId(): Promise<UUID> {
  const session = makeSession(SESSION_A, "probe");
  const acp = makeAcp([session]);
  const { runtime, createEntity } = makeRuntime({ acp: acp.service });
  const router = await SubAgentRouter.start(runtime);
  acp.emit(SESSION_A, "task_complete", { response: "done" });
  await flush();
  await router.stop();
  const entity = createEntity.mock.calls[0]?.[0] as { id: UUID } | undefined;
  if (!entity) throw new Error("expected createEntity to be called");
  return entity.id;
}

function legacyEntity(id: string, sessionId: string, label: string): Entity {
  return {
    id: id as UUID,
    agentId: AGENT_ID,
    names: [`sub-agent: ${label}`],
    metadata: {
      sub_agent: { subAgentSessionId: sessionId, subAgentAgentType: "codex" },
    },
  };
}

function humanEntity(id: string, name: string): Entity {
  return { id: id as UUID, agentId: AGENT_ID, names: [name] };
}

describe("shared sub-agent entity (forward path)", () => {
  it("attributes every session's posts to ONE shared entity while each memory keeps its own sessionId", async () => {
    const sessions = [
      makeSession(SESSION_A, "task-a"),
      makeSession(
        SESSION_B,
        "task-b",
        "88888888-7777-6666-5555-444444444444" as UUID,
      ),
    ];
    const acp = makeAcp(sessions);
    const { runtime, handleMessage, createEntity, addParticipant } =
      makeRuntime({ acp: acp.service });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_A, "task_complete", { response: "result A" });
    await flush();
    acp.emit(SESSION_B, "task_complete", { response: "result B" });
    await flush();

    // One deterministic entity id across BOTH sessions — entity growth is
    // O(1) per agent, not O(sessions).
    const createdIds = createEntity.mock.calls.map(
      (c) => (c[0] as { id: UUID }).id,
    );
    expect(createdIds).toHaveLength(2);
    expect(new Set(createdIds).size).toBe(1);
    const sharedId = createdIds[0];

    // The shared entity carries a static shared marker and a generic name —
    // never per-session data (a sessionId here is exactly what the legacy
    // sweep classifies as stale).
    for (const call of createEntity.mock.calls) {
      const entity = call[0] as Entity;
      expect(entity.names).toEqual(["sub-agents"]);
      expect(entity.metadata).toEqual({ sub_agent: { shared: true } });
      expect(isLegacySubAgentEntityMetadata(entity.metadata)).toBe(false);
    }

    // Participation and memory attribution both use the shared id, and
    // per-session identity survives on each memory's metadata.
    for (const call of addParticipant.mock.calls) {
      expect(call[0]).toBe(sharedId);
    }
    expect(handleMessage).toHaveBeenCalledTimes(2);
    const posted = handleMessage.mock.calls.map((c) => c[1] as Memory);
    const sessionIds = posted.map(
      (m) =>
        (m.content?.metadata as Record<string, unknown>)?.subAgentSessionId,
    );
    expect(posted.every((m) => m.entityId === sharedId)).toBe(true);
    expect(new Set(sessionIds)).toEqual(new Set([SESSION_A, SESSION_B]));
    const labels = posted.map(
      (m) => (m.content?.metadata as Record<string, unknown>)?.subAgentLabel,
    );
    expect(new Set(labels)).toEqual(new Set(["task-a", "task-b"]));

    await router.stop();
  });
});

describe("legacy per-session entity sweep (migration path)", () => {
  it("unlinks exactly the marker-bearing entities — humans and the shared entity survive, and nothing is deleted from the entities table", async () => {
    const sharedId = await resolveSharedEntityId();
    const legacyA = legacyEntity(
      "10000000-0000-0000-0000-00000000000a",
      "dead-session-a",
      "old task a",
    );
    const legacyB = legacyEntity(
      "10000000-0000-0000-0000-00000000000b",
      "dead-session-b",
      "old task b",
    );
    const human = humanEntity("20000000-0000-0000-0000-000000000001", "nubs");
    const shared: Entity = {
      id: sharedId,
      agentId: AGENT_ID,
      names: ["sub-agents"],
      metadata: { sub_agent: { shared: true } },
    };
    // An entity with an UNMARKED metadata bag (e.g. connector-created) must
    // never classify as stale, whatever its name looks like.
    const nameOnly: Entity = {
      id: "20000000-0000-0000-0000-000000000002" as UUID,
      agentId: AGENT_ID,
      names: ["sub-agent: imposter (no marker)"],
    };

    const session = makeSession(SESSION_A, "fresh-task");
    const acp = makeAcp([session]);
    const { runtime, getEntitiesForRoom, deleteParticipants } = makeRuntime({
      acp: acp.service,
      roomEntities: [legacyA, human, shared, legacyB, nameOnly],
    });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_A, "task_complete", { response: "done" });
    await flush();

    expect(deleteParticipants).toHaveBeenCalledTimes(1);
    const pairs = deleteParticipants.mock.calls[0]?.[0] as Array<{
      entityId: UUID;
      roomId: UUID;
    }>;
    expect(new Set(pairs.map((p) => p.entityId))).toEqual(
      new Set([legacyA.id, legacyB.id]),
    );
    expect(pairs.every((p) => p.roomId === ROOM)).toBe(true);

    // Memoized: a second event in the same room performs no second room scan.
    const scans = getEntitiesForRoom.mock.calls.length;
    acp.emit(SESSION_A, "task_complete", { response: "done again" });
    await flush();
    expect(getEntitiesForRoom.mock.calls.length).toBe(scans);
    expect(deleteParticipants).toHaveBeenCalledTimes(1);

    await router.stop();
  });

  it("sweeps the origin room on the session's FIRST event (spawn-time heal, before any completion)", async () => {
    const legacy = legacyEntity(
      "10000000-0000-0000-0000-00000000000c",
      "dead-session-c",
      "old task c",
    );
    const session = makeSession(SESSION_A, "streaming-task");
    const acp = makeAcp([session]);
    const { runtime, deleteParticipants, handleMessage } = makeRuntime({
      acp: acp.service,
      roomEntities: [legacy],
    });
    const router = await SubAgentRouter.start(runtime);

    // "message" is a streamed non-inject event — nothing is posted, but the
    // polluted origin room heals immediately.
    acp.emit(SESSION_A, "message", { text: "working…" });
    await flush();

    expect(handleMessage).not.toHaveBeenCalled();
    expect(deleteParticipants).toHaveBeenCalledTimes(1);
    const pairs = deleteParticipants.mock.calls[0]?.[0] as Array<{
      entityId: UUID;
    }>;
    expect(pairs.map((p) => p.entityId)).toEqual([legacy.id]);

    await router.stop();
  });

  it("surfaces a failed sweep via reportError, drops the memo, and retries on the next event", async () => {
    const legacy = legacyEntity(
      "10000000-0000-0000-0000-00000000000d",
      "dead-session-d",
      "old task d",
    );
    let calls = 0;
    const session = makeSession(SESSION_A, "retry-task");
    const acp = makeAcp([session]);
    const { runtime, deleteParticipants, reportError } = makeRuntime({
      acp: acp.service,
      roomEntities: [legacy],
      deleteParticipantsImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("db offline");
        return true;
      },
    });
    const router = await SubAgentRouter.start(runtime);

    acp.emit(SESSION_A, "task_complete", { response: "first" });
    await flush();
    expect(reportError).toHaveBeenCalledWith(
      "SubAgentRouter.sweepLegacySubAgentParticipants",
      expect.any(Error),
      { roomId: ROOM },
    );

    // Memo was dropped, so the next event retries — and this time succeeds.
    acp.emit(SESSION_A, "task_complete", { response: "second" });
    await flush();
    expect(deleteParticipants).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);

    await router.stop();
  });
});

describe("isLegacySubAgentEntityMetadata", () => {
  it("classifies only the structural per-session creation marker as legacy", () => {
    expect(
      isLegacySubAgentEntityMetadata({
        sub_agent: { subAgentSessionId: "abc", subAgentAgentType: "codex" },
      }),
    ).toBe(true);
    expect(
      isLegacySubAgentEntityMetadata({ sub_agent: { shared: true } }),
    ).toBe(false);
    expect(isLegacySubAgentEntityMetadata(undefined)).toBe(false);
    expect(isLegacySubAgentEntityMetadata({})).toBe(false);
    expect(isLegacySubAgentEntityMetadata({ sub_agent: "abc" })).toBe(false);
    expect(isLegacySubAgentEntityMetadata({ sub_agent: ["abc"] })).toBe(false);
    expect(
      isLegacySubAgentEntityMetadata({ sub_agent: { subAgentSessionId: 7 } }),
    ).toBe(false);
  });
});

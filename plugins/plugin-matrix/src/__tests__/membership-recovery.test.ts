/**
 * Recovery-path tests for MatrixService membership publication: the r4
 * review fixes for issue #24368. Covers (1) recovery publishing the FRESH
 * server roster rather than the SDK's cached one, (2) persisted non-current
 * scope health triggering recovery even without an in-memory flag, and
 * direct-room ordering (recovery before the <=2 skip), (3) unknown
 * membership values being reported instead of recorded as leave. All SDK and
 * authority surfaces are in-memory doubles — no live homeserver.
 */
import { EventEmitter } from "node:events";
import type { IAgentRuntime } from "@elizaos/core";
import { createUniqueUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { MatrixService } from "../service.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Mirrors the production matrixScopedUuid derivation in service.ts: core's
 * createUniqueUuid stamps a version nibble of 0, which the canonical
 * membership authority rejects, so Matrix-derived rows re-stamp the RFC 4122
 * version (5) and variant (8) nibbles on top of the same deterministic base.
 */
function matrixScopedUuidForTest(runtime: IAgentRuntime, seed: string): string {
  const base = createUniqueUuid(runtime, seed);
  return `${base.slice(0, 14)}5${base.slice(15, 19)}8${base.slice(20)}`;
}

function createRuntime(): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    reportError: vi.fn(),
    emitEvent: vi.fn(),
    createWorld: vi.fn().mockResolvedValue(undefined),
    createRoom: vi.fn().mockResolvedValue(undefined),
    createEntity: vi.fn().mockResolvedValue(undefined),
    ensureWorldExists: vi.fn().mockResolvedValue(undefined),
    ensureRoomExists: vi.fn().mockResolvedValue(undefined),
  } as unknown as IAgentRuntime;
}

/** Minimal authority double exposing only what the publication pass uses. */
function createAuthority() {
  const snapshots: { roomId: string; members: string[] }[] = [];
  const staleCalls: { roomId: string; reason: string }[] = [];
  return {
    snapshots,
    staleCalls,
    isRoomIncomplete: vi.fn((): boolean => false),
    reportIncomplete: vi.fn(async () => {}),
    clearTransientRoomIncompleteness: vi.fn(() => true),
    scopeHealth: vi.fn(async (): Promise<{ health: string } | null> => null),
    clearScopeRemoval: vi.fn(() => {}),
    markScopeUnavailable: vi.fn(async () => {}),
    recordTransition: vi.fn(async () => {}),
    markScopeStale: vi.fn(async (input: { roomId: string; reason: string }) => {
      staleCalls.push({ roomId: input.roomId, reason: input.reason });
    }),
    publishSnapshot: vi.fn(
      async (input: { roomId: string; members: { canonicalPrincipalId: string }[] }) => {
        snapshots.push({
          roomId: input.roomId,
          members: input.members.map((m) => m.canonicalPrincipalId),
        });
        return true;
      }
    ),
  };
}

function createRoomDouble(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "!ops:example",
    name: "Ops",
    getMyMembership: vi.fn(() => "join"),
    getJoinedMemberCount: vi.fn(() => 5),
    getJoinedMembers: vi.fn(() => [
      { userId: "@stale:example", powerLevel: 0 },
      { userId: "@bot:example", powerLevel: 0 },
    ]),
    getMember: vi.fn(() => null),
    loadMembersIfNeeded: vi.fn(async () => {}),
    ...overrides,
  };
}

interface Harness {
  service: MatrixService;
  state: Record<string, unknown>;
  authority: ReturnType<typeof createAuthority>;
  client: Record<string, ReturnType<typeof vi.fn>>;
  runtime: IAgentRuntime;
}

function createHarness(): Harness {
  const runtime = createRuntime();
  const authority = createAuthority();
  const client = Object.assign(new EventEmitter(), {
    getRooms: vi.fn(() => [] as unknown[]),
    getRoom: vi.fn(() => null),
    // Absent crypto: the verification-auto-accept tail of
    // setupEventHandlers is inert for these sync-path tests.
    getCrypto: vi.fn(() => undefined),
    // Real boundary shape (matrix-js-sdk 41.x): client.members() resolves the
    // raw homeserver /members envelope consumed via response.chunk — see
    // Room.loadMembersFromServer() — not a userId -> event-arrays map.
    members: vi.fn(async () => ({
      chunk: [
        { state_key: "@fresh1:example", content: { membership: "join" } },
        { state_key: "@fresh2:example", content: { membership: "join" } },
        { state_key: "@fresh3:example", content: { membership: "join" } },
        { state_key: "@bot:example", content: { membership: "join" } },
      ],
    })),
  });
  const state: Record<string, unknown> = {
    accountId: "work",
    settings: { userId: "@bot:example", accountId: "work" },
    client,
    membershipAuthority: authority,
    membershipSnapshotCounter: 0,
    membershipSnapshotToken: "tok",
    connected: true,
    syncing: true,
  };
  const service = Object.create(MatrixService.prototype) as MatrixService;
  Object.assign(service, { runtime });
  (service as unknown as { states: Map<string, unknown> }).states = new Map([["work", state]]);
  return {
    service,
    state,
    authority,
    client,
    runtime,
  };
}

describe("recovery publishes the fresh server roster, not the stale SDK roster", () => {
  it("feeds the client.members roster into the snapshot when the room is flagged incomplete", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    expect(h.client.members).toHaveBeenCalledWith("!ops:example", "join");
    expect(h.authority.snapshots).toHaveLength(1);
    // The published roster must be the FRESH fetch (4 fresh ids), not the
    // SDK Room model's stale roster (2 ids).
    expect(h.authority.snapshots[0]?.members).toHaveLength(4);
  });

  it("fails closed when the fresh fetch fails, leaving the room incomplete", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    h.client.members.mockRejectedValue(new Error("network"));
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    expect(h.authority.reportIncomplete).toHaveBeenCalled();
    expect(h.authority.snapshots).toHaveLength(0);
  });
});

describe("persisted non-current scope health triggers recovery", () => {
  it("recovers a stale persisted scope even without an in-memory incompleteness flag", async () => {
    const h = createHarness();
    h.authority.scopeHealth = vi.fn(async () => ({ health: "stale" }));
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    expect(h.authority.scopeHealth).toHaveBeenCalledWith({ roomId: "!ops:example" });
    expect(h.authority.snapshots).toHaveLength(1);
  });

  it("checks recovery BEFORE the direct-room skip so a partial group is not stranded", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    // SDK Room model reports a lazily-loaded group as <=2 members.
    const room = createRoomDouble({ getJoinedMemberCount: vi.fn(() => 1) });
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    // Recovery still ran (fresh fetch, publish) despite the <=2 SDK count.
    expect(h.authority.snapshots).toHaveLength(1);
  });

  it("clears the transient flag without publishing when a fresh roster shows a true direct room", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    h.client.members.mockResolvedValue({
      chunk: [
        { state_key: "@one:example", content: { membership: "join" } },
        { state_key: "@bot:example", content: { membership: "join" } },
      ],
    });
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    expect(h.authority.snapshots).toHaveLength(0);
    expect(h.authority.clearTransientRoomIncompleteness).toHaveBeenCalled();
  });

  it("publishes a shrunken fresh roster when BOTH a transient flag and a persisted non-current scope exist", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    h.authority.scopeHealth = vi.fn(async () => ({ health: "stale" }));
    h.client.members.mockResolvedValue({
      chunk: [
        { state_key: "@one:example", content: { membership: "join" } },
        { state_key: "@bot:example", content: { membership: "join" } },
      ],
    });
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, true);
    // The persisted stale scope must be restored by the (small) complete
    // roster, not left stranded by a flag-only clear.
    expect(h.authority.snapshots).toHaveLength(1);
  });

  it("fails closed on a scope-health probe failure instead of publishing the SDK cache", async () => {
    const h = createHarness();
    h.authority.scopeHealth = vi.fn(async () => {
      throw new Error("db down");
    });
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, true);
    // Probe failure must route through fresh-roster recovery; the fresh
    // fetch succeeds here, so the published roster is the fresh one.
    expect(h.client.members).toHaveBeenCalled();
    expect(h.authority.snapshots).toHaveLength(1);
  });

  it("never publishes from the SDK cache on a non-first sync", async () => {
    const h = createHarness();
    // No incompleteness, current persisted health — but firstSync=false.
    h.authority.scopeHealth = vi.fn(async () => ({ health: "current" }));
    h.client.members.mockRejectedValue(new Error("network down"));
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    // Fail closed: no fresh roster => no publication at all (the SDK cache
    // is not evidence on a reconnect pass), and the room is flagged.
    expect(h.authority.snapshots).toHaveLength(0);
    expect(h.authority.reportIncomplete).toHaveBeenCalled();
  });
});

describe("unknown membership values are reported, never recorded as leave", () => {
  it("reports and skips a knock transition instead of revoking the principal", async () => {
    const h = createHarness();
    const event = {
      getSender: vi.fn(() => "@alice:example"),
      getRoomId: vi.fn(() => "!ops:example"),
      getId: vi.fn(() => "$e"),
      getTs: vi.fn(() => 1),
    };
    const member = { userId: "@alice:example", membership: "knock", previousMembership: "join" };
    const oldMembership = "join";
    const svc = h.service as unknown as Record<string, unknown>;
    const handler = svc.handleMembershipTransition as
      | ((
          s: unknown,
          e: unknown,
          m: unknown,
          old: string | undefined,
          room?: unknown
        ) => Promise<void>)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error("handleMembershipTransition not found on MatrixService prototype");
    }
    await handler.call(h.service, h.state, event, member, oldMembership);
    expect(h.runtime.reportError).toHaveBeenCalled();
    expect(h.authority.publishSnapshot).not.toHaveBeenCalled();
  });

  it("a peer leave in a direct room must not create authority evidence (review control)", async () => {
    const h = createHarness();
    const event = {
      getSender: vi.fn(() => "@peer:example"),
      getRoomId: vi.fn(() => "!dm:example"),
      getId: vi.fn(() => "$dm-leave"),
      getTs: vi.fn(() => 1),
    };
    const member = { userId: "@peer:example", membership: "leave", previousMembership: "join" };
    const svc = h.service as unknown as Record<string, unknown>;
    const handler = svc.handleMembershipTransition as
      | ((
          s: unknown,
          e: unknown,
          m: unknown,
          old: string | undefined,
          room?: unknown
        ) => Promise<void>)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error("handleMembershipTransition not found on MatrixService prototype");
    }
    // The SDK Room model for a direct room: at most two joined members.
    const dmRoom = createRoomDouble({
      roomId: "!dm:example",
      getJoinedMemberCount: vi.fn(() => 1),
    });
    h.client.getRoom.mockReturnValue(dmRoom);
    await handler.call(h.service, h.state, event, member, "join", dmRoom);
    expect(h.authority.recordTransition).not.toHaveBeenCalled();
    expect(h.authority.markScopeUnavailable).not.toHaveBeenCalled();
    expect(h.runtime.createEntity).not.toHaveBeenCalled();
  });

  it("a peer leave in a GROUP room still records the ordered-delta transition", async () => {
    const h = createHarness();
    const event = {
      getSender: vi.fn(() => "@peer:example"),
      getRoomId: vi.fn(() => "!ops:example"),
      getId: vi.fn(() => "$ops-leave"),
      getTs: vi.fn(() => 1),
    };
    const member = { userId: "@peer:example", membership: "leave", previousMembership: "join" };
    const svc = h.service as unknown as Record<string, unknown>;
    const handler = svc.handleMembershipTransition as
      | ((
          s: unknown,
          e: unknown,
          m: unknown,
          old: string | undefined,
          room?: unknown
        ) => Promise<void>)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error("handleMembershipTransition not found on MatrixService prototype");
    }
    const groupRoom = createRoomDouble();
    h.client.getRoom.mockReturnValue(groupRoom);
    await handler.call(h.service, h.state, event, member, "join", groupRoom);
    expect(h.authority.recordTransition).toHaveBeenCalledTimes(1);
    expect(h.runtime.createEntity).toHaveBeenCalled();
  });

  it("a peer leave in a governed room that shrank to 2 members still records the revocation", async () => {
    // The DM skip must key on the authority's persisted scope row, not room
    // size: a governed group that lost members down to two joined (bot +
    // subject) looks DM-sized, and a size-keyed skip would strand the
    // departing member as active in canonical authority state forever.
    const h = createHarness();
    const event = {
      getSender: vi.fn(() => "@peer:example"),
      getRoomId: vi.fn(() => "!shrunk:example"),
      getId: vi.fn(() => "$shrunk-leave"),
      getTs: vi.fn(() => 1),
    };
    const member = { userId: "@peer:example", membership: "leave", previousMembership: "join" };
    const svc = h.service as unknown as Record<string, unknown>;
    const handler = svc.handleMembershipTransition as
      | ((
          s: unknown,
          e: unknown,
          m: unknown,
          old: string | undefined,
          room?: unknown
        ) => Promise<void>)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error("handleMembershipTransition not found on MatrixService prototype");
    }
    // Persisted scope row EXISTS (governed evidence) while the SDK model
    // reports a DM-shaped room: 1 remaining joined member (the bot) + the
    // leaving subject = 2 total.
    h.authority.scopeHealth.mockResolvedValue({ health: "current" });
    const shrunkRoom = createRoomDouble({
      roomId: "!shrunk:example",
      getJoinedMemberCount: vi.fn(() => 1),
    });
    h.client.getRoom.mockReturnValue(shrunkRoom);
    await handler.call(h.service, h.state, event, member, "join", shrunkRoom);
    expect(h.authority.scopeHealth).toHaveBeenCalledWith({ roomId: "!shrunk:example" });
    expect(h.authority.recordTransition).toHaveBeenCalledTimes(1);
  });

  it("a peer leave with a failed scope-health probe reports and drops without creating authority evidence", async () => {
    // The authority store itself is down — recordTransition would hit the
    // same store and its ensureRegistered would MINT a scope row for a
    // possible DM as a side effect of a doomed write (and that
    // publisher-only scope row would later block the grown-room baseline
    // bootstrap, which only runs when scopeHealth is null). The safe
    // behavior is report-and-drop: the next roster publication pass
    // re-derives the full baseline from fresh server state.
    const h = createHarness();
    const event = {
      getSender: vi.fn(() => "@peer:example"),
      getRoomId: vi.fn(() => "!maybe:example"),
      getId: vi.fn(() => "$probe-fail-leave"),
      getTs: vi.fn(() => 1),
    };
    const member = { userId: "@peer:example", membership: "leave", previousMembership: "join" };
    const svc = h.service as unknown as Record<string, unknown>;
    const handler = svc.handleMembershipTransition as
      | ((
          s: unknown,
          e: unknown,
          m: unknown,
          old: string | undefined,
          room?: unknown
        ) => Promise<void>)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error("handleMembershipTransition not found on MatrixService prototype");
    }
    h.authority.scopeHealth.mockRejectedValue(new Error("store down"));
    const dmRoom = createRoomDouble({
      roomId: "!maybe:example",
      getJoinedMemberCount: vi.fn(() => 1),
    });
    h.client.getRoom.mockReturnValue(dmRoom);
    await handler.call(h.service, h.state, event, member, "join", dmRoom);
    expect(h.runtime.reportError).toHaveBeenCalledWith(
      "matrix:membership-transition",
      expect.any(Error),
      expect.objectContaining({ roomId: "!maybe:example" })
    );
    expect(h.authority.recordTransition).not.toHaveBeenCalled();
  });

  it("a bootstrap (ensureWorldExists) rejection propagates out of the transition and is reported, not silently logged", async () => {
    // The transition handler's runtime bootstrap (ensureWorldExists) can
    // fail (store down); the Membership event callback must surface the
    // dropped evidence via runtime.reportError so RECENT_ERRORS shows it —
    // a logger.error alone hides permanently lost membership evidence.
    const h = createHarness();
    vi.mocked(h.runtime.ensureWorldExists).mockRejectedValueOnce(new Error("world store down"));
    const event = {
      getSender: vi.fn(() => "@peer:example"),
      getRoomId: vi.fn(() => "!ops:example"),
      getId: vi.fn(() => "$boot-fail"),
      getTs: vi.fn(() => 1),
    };
    const member = { userId: "@peer:example", membership: "leave", previousMembership: "join" };
    const svc = h.service as unknown as Record<string, unknown>;
    const handler = svc.handleMembershipTransition as
      | ((
          s: unknown,
          e: unknown,
          m: unknown,
          old: string | undefined,
          room?: unknown
        ) => Promise<void>)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error("handleMembershipTransition not found on MatrixService prototype");
    }
    const groupRoom = createRoomDouble();
    h.client.getRoom.mockReturnValue(groupRoom);
    // The handler itself must REJECT (bootstrap failure propagates); the
    // event callback's catch is what reports it in production.
    await expect(
      handler.call(h.service, h.state, event, member, "join", groupRoom)
    ).rejects.toThrow("world store down");
    expect(h.authority.recordTransition).not.toHaveBeenCalled();
  });

  it("the bot's own ban in a <=2-member room still tombstones the scope", async () => {
    const h = createHarness();
    const event = {
      getSender: vi.fn(() => "@admin:example"),
      getRoomId: vi.fn(() => "!dm:example"),
      getId: vi.fn(() => "$bot-ban"),
      getTs: vi.fn(() => 1),
    };
    // The bot's OWN transition in a room reporting <=2 joined members — the
    // direct-room skip must NOT swallow the bot self-leave lifecycle.
    const member = { userId: "@bot:example", membership: "ban", previousMembership: "join" };
    const svc = h.service as unknown as Record<string, unknown>;
    const handler = svc.handleMembershipTransition as
      | ((
          s: unknown,
          e: unknown,
          m: unknown,
          old: string | undefined,
          room?: unknown
        ) => Promise<void>)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error("handleMembershipTransition not found on MatrixService prototype");
    }
    const dmRoom = createRoomDouble({
      roomId: "!dm:example",
      getJoinedMemberCount: vi.fn(() => 1),
    });
    h.client.getRoom.mockReturnValue(dmRoom);
    await handler.call(h.service, h.state, event, member, "join", dmRoom);
    expect(h.authority.markScopeUnavailable).toHaveBeenCalledWith({
      roomId: "!dm:example",
      reason: "bot_banned",
    });
    expect(h.authority.recordTransition).not.toHaveBeenCalled();
  });
});

describe("fresh roster parsing matches the homeserver /members envelope", () => {
  it("parses the SDK /members chunk response instead of the invented map shape", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    // Real boundary shape (matrix-js-sdk 41.x): client.members() resolves the
    // raw homeserver /members envelope, and Room.loadMembersFromServer()
    // consumes response.chunk — a { chunk: IStateEventWithRoomId[] } object,
    // NOT a userId -> event-arrays map.
    h.client.members.mockResolvedValue({
      chunk: [
        { state_key: "@fresh1:example", content: { membership: "join" } },
        { state_key: "@fresh2:example", content: { membership: "join" } },
        { state_key: "@fresh3:example", content: { membership: "join" } },
        { state_key: "@bot:example", content: { membership: "join" } },
      ],
    });
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    expect(h.authority.snapshots).toHaveLength(1);
    // Exact identities, not just counts: assert the EXACT derived principal
    // UUIDs (same derivation production uses) so a parser emitting wrong
    // identifiers (e.g. the literal "chunk" key) fails here.
    const expected = ["@fresh1:example", "@fresh2:example", "@fresh3:example", "@bot:example"].map(
      (matrixId) => matrixScopedUuidForTest(h.runtime, `work:${matrixId}`)
    );
    expect(h.authority.snapshots[0]?.members.sort()).toEqual(expected.sort());
  });

  it("ignores non-join chunk events (leave/invite) on the fresh roster", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    h.client.members.mockResolvedValue({
      chunk: [
        { state_key: "@fresh1:example", content: { membership: "join" } },
        { state_key: "@fresh2:example", content: { membership: "join" } },
        { state_key: "@gone:example", content: { membership: "leave" } },
        { state_key: "@invited:example", content: { membership: "invite" } },
        { state_key: "@bot:example", content: { membership: "join" } },
      ],
    });
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    expect(h.authority.snapshots).toHaveLength(1);
    expect(h.authority.snapshots[0]?.members).toHaveLength(3);
  });

  it("fails closed on a malformed envelope (no chunk array): no snapshot, room stays incomplete", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    // A homeserver/SDK response that is an object but NOT the expected
    // { chunk: [...] } envelope (e.g. an error body): the parser must return
    // null so the room stays incomplete — never publish a complete snapshot
    // from an unparseable roster.
    h.client.members.mockResolvedValue({ error: "M_UNKNOWN", not_chunk: true });
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    expect(h.authority.snapshots).toHaveLength(0);
    expect(h.authority.reportIncomplete).toHaveBeenCalled();
    // The transient flag is NOT cleared: recovery will retry next pass.
    expect(h.authority.clearTransientRoomIncompleteness).not.toHaveBeenCalled();
  });

  it("fails closed on a structurally invalid chunk ENTRY: no partial roster becomes a baseline", async () => {
    const h = createHarness();
    h.authority.isRoomIncomplete = vi.fn(() => true);
    // Valid joins plus ONE malformed entry (missing content.membership): the
    // parser cannot know the skipped event was irrelevant — skipping it would
    // publish a partial roster as a complete snapshot and clear the flag.
    h.client.members.mockResolvedValue({
      chunk: [
        { state_key: "@fresh1:example", content: { membership: "join" } },
        { state_key: "@fresh2:example", content: { membership: "join" } },
        { state_key: "@bot:example" },
        { state_key: "@fresh3:example", content: { membership: "join" } },
      ],
    });
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    await (
      h.service as unknown as {
        publishMembershipSnapshots: (s: unknown, first: boolean) => Promise<void>;
      }
    ).publishMembershipSnapshots(h.state, false);
    expect(h.authority.snapshots).toHaveLength(0);
    expect(h.authority.reportIncomplete).toHaveBeenCalled();
    expect(h.authority.clearTransientRoomIncompleteness).not.toHaveBeenCalled();
  });
});

describe("reconnect degrade attempts every joined room even when one durable write fails", () => {
  it("one failed markScopeStale write does not abort degradation of later rooms", async () => {
    const h = createHarness();
    const first = createRoomDouble({ roomId: "!first:example" });
    const second = createRoomDouble({ roomId: "!second:example" });
    h.client.getRooms.mockReturnValue([first, second]);
    h.authority.markScopeStale.mockImplementation(
      async (input: { roomId: string; reason: string }) => {
        if (input.roomId === "!first:example") {
          throw new Error("durable write failed");
        }
        h.authority.staleCalls.push({ roomId: input.roomId, reason: input.reason });
      }
    );
    // The aggregate failure must surface (the reconnect handler logs it and
    // the next sync retries) — never swallowed silently.
    await expect(
      (
        h.service as unknown as {
          degradeAllMembershipScopes: (s: unknown, reason: string) => Promise<void>;
        }
      ).degradeAllMembershipScopes(h.state, "sync_error")
    ).rejects.toThrow("durable write failed");
    // The failing room's write rejected, but the SECOND room must still have
    // been attempted (its principals must not stay authorized on stale
    // evidence across the reconnect gap).
    expect(h.authority.markScopeStale).toHaveBeenCalledTimes(2);
    expect(h.authority.markScopeStale).toHaveBeenNthCalledWith(1, {
      roomId: "!first:example",
      reason: "sync_error",
    });
    expect(h.authority.markScopeStale).toHaveBeenNthCalledWith(2, {
      roomId: "!second:example",
      reason: "sync_error",
    });
  });
});

describe("non-Error rejection values still surface from the degrade loop", () => {
  it("a null rejection is retained and rethrown, not swallowed by the sentinel", async () => {
    const h = createHarness();
    const first = createRoomDouble({ roomId: "!first:example" });
    const second = createRoomDouble({ roomId: "!second:example" });
    h.client.getRooms.mockReturnValue([first, second]);
    h.authority.markScopeStale.mockImplementation(async (input: { roomId: string }) => {
      if (input.roomId === "!first:example") {
        throw null; // eslint-disable-line no-throw-literal -- the sentinel-under-test
      }
    });
    await expect(
      (
        h.service as unknown as {
          degradeAllMembershipScopes: (s: unknown, reason: string) => Promise<void>;
        }
      ).degradeAllMembershipScopes(h.state, "sync_error")
    ).rejects.toBeNull();
    expect(h.authority.markScopeStale).toHaveBeenCalledTimes(2);
  });
});

describe("a CACHED PREPARED must not publish the SDK store as fresh evidence", () => {
  // Drives the REAL setupEventHandlers sync listener (not a direct
  // publishMembershipSnapshots call): a restart that resumes from the SDK
  // store reports PREPARED with syncData.fromCache=true. The firstPrepared
  // predicate must treat it as non-first, so publication can only come from
  // a genuinely fresh server roster — with the network down the room stays
  // unpublished rather than restoring a possibly-stale cached roster as
  // current evidence.
  function emitPrepared(
    h: Harness,
    syncData: { oldSyncToken: string | null; fromCache: boolean } | undefined
  ): void {
    // Wire the REAL sync listener (setupEventHandlers registers it against
    // sdk.ClientEvent.Sync === "sync"), then emit through it. getCrypto is
    // absent on the double, so the verification tail is inert.
    const svc = h.service as unknown as { setupEventHandlers: (s: unknown) => void };
    svc.setupEventHandlers(h.state);
    (h.client as unknown as EventEmitter).emit("sync", "PREPARED", null, syncData);
  }

  async function waitForPass(): Promise<void> {
    // The sync handler fires publication as a void promise; let pending
    // microtasks (and any awaited authority calls inside the pass) settle.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it("skips publication on a fromCache PREPARED even when the SDK room model is complete", async () => {
    const h = createHarness();
    // A complete, healthy room in the SDK store: no incompleteness flag,
    // current persisted health, joined members present. Only a fresh server
    // roster could legitimately publish it — and the network is down.
    h.authority.scopeHealth = vi.fn(async () => ({ health: "current" }));
    h.client.members.mockRejectedValue(new Error("network down"));
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    emitPrepared(h, { oldSyncToken: null, fromCache: true });
    await waitForPass();
    // Fail closed: a cached PREPARED is not fresh evidence, and the dead
    // network means no fresh roster — nothing may be published.
    expect(h.authority.snapshots).toHaveLength(0);
    expect(h.client.members).toHaveBeenCalled();
    expect(h.authority.reportIncomplete).toHaveBeenCalled();
  });

  it("publishes on a fresh PREPARED (no syncData) when the roster is complete", async () => {
    const h = createHarness();
    h.authority.scopeHealth = vi.fn(async () => ({ health: "current" }));
    h.client.members.mockRejectedValue(new Error("network down"));
    const room = createRoomDouble();
    h.client.getRooms.mockReturnValue([room]);
    // Fresh PREPARED with no syncData at all: firstPrepared is true, and the
    // SDK room model is complete (5 joined members) so the snapshot path
    // publishes directly without a fresh-roster fetch.
    emitPrepared(h, undefined);
    await waitForPass();
    expect(h.authority.snapshots).toHaveLength(1);
  });
});

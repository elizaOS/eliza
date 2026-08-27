/**
 * Recovery-path tests for MatrixService membership publication: the r4
 * review fixes for issue #24368. Covers (1) recovery publishing the FRESH
 * server roster rather than the SDK's cached one, (2) persisted non-current
 * scope health triggering recovery even without an in-memory flag, and
 * direct-room ordering (recovery before the <=2 skip), (3) unknown
 * membership values being reported instead of recorded as leave. All SDK and
 * authority surfaces are in-memory doubles — no live homeserver.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { MatrixService } from "../service.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function createRuntime(): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    reportError: vi.fn(),
    createWorld: vi.fn().mockResolvedValue(undefined),
    createRoom: vi.fn().mockResolvedValue(undefined),
    createEntity: vi.fn().mockResolvedValue(undefined),
  } as unknown as IAgentRuntime;
}

/** Minimal authority double exposing only what the publication pass uses. */
function createAuthority() {
  const snapshots: { roomId: string; members: string[] }[] = [];
  return {
    snapshots,
    isRoomIncomplete: vi.fn((): boolean => false),
    reportIncomplete: vi.fn(async () => {}),
    clearTransientRoomIncompleteness: vi.fn(() => true),
    scopeHealth: vi.fn(async (): Promise<{ health: string } | null> => null),
    clearScopeRemoval: vi.fn(() => {}),
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
  const client = {
    getRooms: vi.fn(() => [] as unknown[]),
    getRoom: vi.fn(() => null),
    members: vi.fn(async () => ({
      "@fresh1:example": [{ content: { membership: "join" } }],
      "@fresh2:example": [{ content: { membership: "join" } }],
      "@fresh3:example": [{ content: { membership: "join" } }],
      "@bot:example": [{ content: { membership: "join" } }],
    })),
  };
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
      "@one:example": [{ content: { membership: "join" } }],
      "@bot:example": [{ content: { membership: "join" } }],
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
      "@one:example": [{ content: { membership: "join" } }],
      "@bot:example": [{ content: { membership: "join" } }],
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
});

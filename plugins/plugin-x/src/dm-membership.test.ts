/**
 * Unit coverage for the X DM client's membership wiring (#24372): roster
 * event routing, own-membership handling, contained publish failures (the
 * account-global dm_cursor must advance regardless), and the auth
 * 401/403 degrade + successful-poll restore cycle. The membership
 * publisher is stubbed at the class boundary (it has its own real-PGlite
 * vertical in __tests__/membership-publisher.real.test.ts); the harness is
 * deterministic with fake sessions.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { AuthenticatedTwitterSession } from "./client/auth";
import { TwitterDirectMessageClient } from "./direct-messages";

const membershipInstances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

vi.mock("./membership", () => {
  // Scope returned to the DM client: a plausible MembershipScope so the
  // publish paths in direct-messages.ts actually execute (R2 finding 3 —
  // a null scope made the roster tests vacuous).
  const scopeFor = (conversationId: string) => ({
    agentId: "00000000-0000-4000-8000-0000000000aa",
    connectorId: "x",
    connectorAccountId: "11111111-2222-4333-8444-555555555555",
    externalWorldId: conversationId,
    externalRoomId: conversationId,
  });
  return {
    XMembershipPublisher: class {
      scopeForConversation = vi.fn(async (opts: { conversationId: string }) =>
        scopeFor(opts.conversationId),
      );
      publishJoin = vi.fn().mockResolvedValue(undefined);
      publishLeave = vi.fn().mockRejectedValue(new Error("publish down"));
      renewSender = vi.fn().mockResolvedValue(undefined);
      degradeScope = vi.fn().mockResolvedValue(undefined);
      degradeAllScopes = vi.fn().mockResolvedValue(undefined);
      restoreAllScopes = vi.fn().mockResolvedValue(undefined);
      restoreScope = vi.fn().mockResolvedValue(undefined);
      // The DM client only restores once this publisher has actually bound
      // at least one scope (process-local knowledge of degraded scopes).
      hasBoundScopes = vi.fn().mockReturnValue(true);
      constructor() {
        membershipInstances.push(
          this as unknown as Record<string, ReturnType<typeof vi.fn>>,
        );
      }
    },
    xMembershipPrincipal: vi.fn().mockResolvedValue({
      principalId: "00000000-0000-4000-8000-000000000001",
    }),
  };
});

const settledWrites: Array<[string, string]> = [];

function fakeRuntime(): IAgentRuntime {
  const cache = new Map<string, string>();
  return {
    agentId: "00000000-0000-4000-8000-0000000000aa",
    getCache: vi.fn(async (k: string) => cache.get(k) ?? null),
    setCache: vi.fn(async (k: string, v: string) => {
      cache.set(k, v);
      settledWrites.push([k, v]);
    }),
    deleteCache: vi.fn(async (k: string) => cache.delete(k)),
    reportError: vi.fn(),
    getRoom: vi.fn().mockResolvedValue(null),
    ensureRoomExists: vi.fn().mockResolvedValue(undefined),
    ensureWorldExists: vi.fn().mockResolvedValue(undefined),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue(null),
    createEntities: vi.fn().mockResolvedValue(undefined),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    getServicesByType: vi.fn().mockReturnValue([]),
    getSetting: vi.fn().mockReturnValue(undefined),
  } as unknown as IAgentRuntime;
}

function fakeSession(events: unknown[], includes?: unknown) {
  return {
    profile: { userId: "990000000000000001" },
    client: {
      v2: {
        listDmEvents: vi.fn().mockResolvedValue({
          events,
          includes,
          done: true,
        }),
        sendDmToParticipant: vi
          .fn()
          .mockResolvedValue({ data: { dm_event_id: "1" } }),
      },
    },
  } as unknown as AuthenticatedTwitterSession;
}

function buildClient(runtime: IAgentRuntime) {
  const clientBase = {
    accountId: "default",
    twitterClient: {
      withAuthenticatedSession: vi.fn(
        async (fn: (s: AuthenticatedTwitterSession) => Promise<void>) =>
          fn(currentSession),
      ),
      isAuthenticatedSessionCurrent: vi.fn().mockReturnValue(true),
    },
  } as unknown as ClientBase;
  let currentSession: AuthenticatedTwitterSession;
  const dm = new TwitterDirectMessageClient(
    clientBase,
    runtime,
    {} as Parameters<
      typeof TwitterDirectMessageClient.prototype.start
    >[0] extends never
      ? never
      : Record<string, never>,
  );
  return {
    dm,
    setSession: (s: AuthenticatedTwitterSession) => {
      currentSession = s;
    },
    clientBase,
  };
}

describe("TwitterDirectMessageClient membership wiring (#24372)", () => {
  beforeEach(() => {
    settledWrites.length = 0;
  });

  it("routes a ParticipantsJoin event through the membership path and advances the cursor", async () => {
    const runtime = fakeRuntime();
    const { dm, setSession } = buildClient(runtime);
    const pub = membershipInstances[membershipInstances.length - 1];
    await runtime.setCache(
      "twitter/default/990000000000000001/dm_cursor",
      "100",
    );
    setSession(
      fakeSession([
        {
          id: "101",
          event_type: "ParticipantsJoin",
          dm_conversation_id: "1999888777660001",
          participant_ids: ["990000000000000002"],
          sender_id: "990000000000000003",
          created_at: "2026-08-26T00:00:00.000Z",
        },
      ]),
    );
    // poll() is private; drive the full path through start()'s first poll.
    await dm.start();
    await dm.stop();
    // The roster event was routed to the membership publisher: one join for
    // the listed participant plus the conversation's first own-membership
    // proof (the account observed the event, proving its own participation).
    expect(pub.scopeForConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "1999888777660001" }),
    );
    expect(pub.publishJoin).toHaveBeenCalledTimes(2);
    const rosterCall = pub.publishJoin.mock.calls.find(
      (call: Array<{ permissionSnapshot: Record<string, unknown> }>) =>
        !call[0].permissionSnapshot?.self,
    );
    expect(rosterCall).toBeDefined();
    expect(
      await runtime.getCache("twitter/default/990000000000000001/dm_cursor"),
    ).toBe("101");
  });

  it("advances the cursor even when a publish fails (degrade-only containment)", async () => {
    const runtime = fakeRuntime();
    const { dm, setSession } = buildClient(runtime);
    const pub = membershipInstances[membershipInstances.length - 1];
    await runtime.setCache(
      "twitter/default/990000000000000001/dm_cursor",
      "200",
    );
    setSession(
      fakeSession([
        {
          id: "201",
          event_type: "ParticipantsLeave",
          dm_conversation_id: "1999888777660002",
          participant_ids: ["990000000000000004"],
          created_at: "2026-08-26T00:00:00.000Z",
        },
      ]),
    );
    await dm.start();
    await dm.stop();
    // The publish was ATTEMPTED and rejected (mock), yet the cursor still
    // advanced past the event: membership failures never stall the DM loop.
    expect(pub.publishLeave).toHaveBeenCalledTimes(1);
    expect(
      await runtime.getCache("twitter/default/990000000000000001/dm_cursor"),
    ).toBe("201");
  });

  it("publishes own membership for a self-sent message and advances the cursor", async () => {
    const runtime = fakeRuntime();
    const { dm, setSession } = buildClient(runtime);
    const pub = membershipInstances[membershipInstances.length - 1];
    await runtime.setCache(
      "twitter/default/990000000000000001/dm_cursor",
      "300",
    );
    setSession(
      fakeSession([
        {
          id: "301",
          event_type: "MessageCreate",
          dm_conversation_id: "1999888777660003",
          sender_id: "990000000000000001", // own user
          text: "self note",
        },
      ]),
    );
    await dm.start();
    await dm.stop();
    // Own participation was published once for the conversation.
    expect(pub.publishJoin).toHaveBeenCalledTimes(1);
    const ownCall = pub.publishJoin.mock.calls[0][0];
    expect(ownCall.permissionSnapshot).toEqual({ observed: true, self: true });
    expect(
      await runtime.getCache("twitter/default/990000000000000001/dm_cursor"),
    ).toBe("301");
  });

  it("degrades all membership scopes on a 401 poll failure and restores on recovery", async () => {
    const runtime = fakeRuntime();
    const before = membershipInstances.length;
    const { dm, setSession } = buildClient(runtime);
    const degraded = membershipInstances[before];
    // First poll throws a 401-shaped error.
    const failing = {
      profile: { userId: "990000000000000001" },
      client: {
        v2: {
          listDmEvents: vi.fn().mockRejectedValue({ data: { status: 401 } }),
        },
      },
    } as unknown as AuthenticatedTwitterSession;
    setSession(failing);
    await dm.start();
    await dm.stop();
    expect(degraded).toBeDefined();
    expect(degraded.degradeAllScopes).toHaveBeenCalledWith("x_auth_failed_401");
    // A transient 429 must NOT degrade scope health.
    setSession({
      profile: { userId: "990000000000000001" },
      client: {
        v2: {
          listDmEvents: vi.fn().mockRejectedValue({ data: { status: 429 } }),
        },
      },
    } as unknown as AuthenticatedTwitterSession);
    await dm.start();
    await dm.stop();
    expect(degraded.degradeAllScopes).toHaveBeenCalledTimes(1);
    // A subsequent successful poll restores the degraded scopes.
    setSession(fakeSession([]));
    await dm.start();
    await dm.stop();
    expect(degraded.restoreAllScopes).toHaveBeenCalledWith("x_auth_recovered");
  });

  it("retries auth recovery when restore-all fails: flag stays set and restore is re-attempted (R4 finding 1)", async () => {
    const runtime = fakeRuntime();
    const before = membershipInstances.length;
    const { dm, setSession } = buildClient(runtime);
    const pub = membershipInstances[before];
    // Enter the degraded state via a 401 poll.
    setSession({
      profile: { userId: "990000000000000001" },
      client: {
        v2: {
          listDmEvents: vi.fn().mockRejectedValue({ data: { status: 401 } }),
        },
      },
    } as unknown as AuthenticatedTwitterSession);
    await dm.start();
    await dm.stop();
    expect(pub.degradeAllScopes).toHaveBeenCalledTimes(1);
    // Restore-all fails on the recovery poll: the failure must NOT be
    // treated as successful recovery.
    pub.restoreAllScopes.mockRejectedValueOnce(new Error("restore down"));
    setSession(fakeSession([]));
    await dm.start();
    await dm.stop();
    expect(pub.restoreAllScopes).toHaveBeenCalledTimes(1);
    // Next successful poll retries the restore (flag was retained).
    setSession(fakeSession([]));
    await dm.start();
    await dm.stop();
    expect(pub.restoreAllScopes).toHaveBeenCalledTimes(2);
    expect(pub.restoreAllScopes).toHaveBeenLastCalledWith("x_auth_recovered");
  });

  it("clears the degraded flag without restoring when no scopes are bound (R4 hasBoundScopes edge)", async () => {
    const runtime = fakeRuntime();
    const before = membershipInstances.length;
    const { dm, setSession } = buildClient(runtime);
    const pub = membershipInstances[before];
    setSession({
      profile: { userId: "990000000000000001" },
      client: {
        v2: {
          listDmEvents: vi.fn().mockRejectedValue({ data: { status: 401 } }),
        },
      },
    } as unknown as AuthenticatedTwitterSession);
    await dm.start();
    await dm.stop();
    // No bound scopes: recovery clears the flag without any restore call,
    // so later polls never force-restore and reset fresh evidence.
    pub.hasBoundScopes.mockReturnValue(false);
    setSession(fakeSession([]));
    await dm.start();
    await dm.stop();
    expect(pub.restoreAllScopes).not.toHaveBeenCalled();
    // And a later poll does not resurrect a stale restore either.
    pub.hasBoundScopes.mockReturnValue(true);
    setSession(fakeSession([]));
    await dm.start();
    await dm.stop();
    expect(pub.restoreAllScopes).not.toHaveBeenCalled();
  });

  it("withholds the cursor when own-rejoin scope restore fails, then succeeds on retry (R4 finding 2)", async () => {
    const runtime = fakeRuntime();
    const before = membershipInstances.length;
    const { dm, setSession } = buildClient(runtime);
    const pub = membershipInstances[before];
    await runtime.setCache(
      "twitter/default/990000000000000001/dm_cursor",
      "400",
    );
    // Own account rejoins; the scope restore fails on the first attempt.
    const rejoinEvent = {
      id: "401",
      event_type: "ParticipantsJoin",
      dm_conversation_id: "1999888777660004",
      participant_ids: ["990000000000000001"], // own user
      sender_id: "990000000000000003",
      created_at: "2026-08-26T00:00:00.000Z",
    };
    pub.restoreScope.mockRejectedValueOnce(new Error("restore down"));
    setSession(fakeSession([rejoinEvent]));
    await dm.start();
    await dm.stop();
    // The restore was attempted and failed: no join evidence may publish
    // and the cursor must stay before the event so it is retried.
    expect(pub.restoreScope).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "own_account_rejoined_conversation" }),
    );
    expect(pub.publishJoin).not.toHaveBeenCalled();
    expect(
      await runtime.getCache("twitter/default/990000000000000001/dm_cursor"),
    ).toBe("400");
    // Retry: restore succeeds, evidence publishes, cursor advances.
    setSession(fakeSession([rejoinEvent]));
    await dm.start();
    await dm.stop();
    expect(pub.publishJoin).toHaveBeenCalled();
    expect(
      await runtime.getCache("twitter/default/990000000000000001/dm_cursor"),
    ).toBe("401");
  });
});

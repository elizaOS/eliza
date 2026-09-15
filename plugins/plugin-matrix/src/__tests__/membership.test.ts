/**
 * Deterministic tests for the Matrix membership authority wiring: complete
 * PREPARED snapshots vs incomplete (limited-sync/lazy-load) rosters, join/
 * invite/leave/ban transition consumption, bot self-leave scope termination,
 * account-scoped UUID derivation, and fail-closed message admission. All
 * authority and SDK surfaces are in-memory test doubles — no live homeserver.
 */

import type {
  IAgentRuntime,
  MembershipAuthorizationDecision,
  MembershipMutationReceipt,
  MembershipRecord,
  MembershipScopeHealth,
  MembershipService,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import {
  classifyMatrixTransition,
  MatrixMembershipAuthority,
  type MatrixMembershipTransition,
  matrixMemberRoles,
  matrixMembershipScope,
  matrixObservedAt,
  matrixTransitionToMembership,
} from "../membership.js";
import { MatrixMembershipMessageGate } from "../membership-gate.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ACCOUNT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const PRINCIPAL_A = "00000000-0000-0000-0000-0000000000aa" as UUID;
const _PRINCIPAL_B = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM = "!ops:example";

function createRuntime(overrides: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    reportError: vi.fn(),
    getCache: vi.fn().mockResolvedValue(undefined),
    setCache: vi.fn().mockResolvedValue(true),
    deleteCache: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as IAgentRuntime;
}

interface RecordedCommand {
  op: string;
  command: Record<string, unknown>;
}

function createAuthorityService(
  membership: MembershipRecord | null = null,
  decision: MembershipAuthorizationDecision = {
    decision: "allowed",
    reason: "active_membership",
    generation: 1,
    health: "current",
    membership: {} as MembershipRecord,
  }
) {
  const commands: RecordedCommand[] = [];
  let scopeHealth: MembershipScopeHealth | null = null;
  // Mirrors SqlMembershipService: one binding per scope, and every evidence
  // command must match the registered publisher instance/generation/mode with
  // exact cursor continuity. This is what makes the snapshot->delta lifecycle
  // tests below meaningful against the real authority contract.
  const bindings = new Map<
    string,
    {
      publisherInstanceId: string;
      publisherGeneration: number;
      evidenceMode: string;
      sourceVersion: number;
      sourceCursor: string | null;
      seenKeys: Set<string>;
    }
  >();
  const authorityError = (code: string, message: string) => {
    const err = new Error(`MEMBERSHIP_${code}: ${message}`);
    (err as Error & { code?: string }).code = `MEMBERSHIP_${code}`;
    return err;
  };
  const service: MembershipService = {
    registerPublisher: vi.fn(async (command) => {
      commands.push({ op: "registerPublisher", command: command as never });
      bindings.set(`${command.agentId}:${command.connectorAccountId}:${command.externalRoomId}`, {
        publisherInstanceId: command.publisherInstanceId,
        publisherGeneration: command.publisherGeneration,
        evidenceMode: command.evidenceMode,
        sourceVersion: -1,
        sourceCursor: null,
        seenKeys: new Set(),
      });
      return {
        contractVersion: 1,
        operation: "publisher",
        idempotentReplay: false,
        committedGeneration: (command.expectedGeneration ?? 0) + 1,
        health: {} as MembershipScopeHealth,
      } satisfies MembershipMutationReceipt;
    }),
    applyCompleteSnapshot: vi.fn(async (command) => {
      const binding = bindings.get(
        `${command.agentId}:${command.connectorAccountId}:${command.externalRoomId}`
      );
      if (!binding) throw authorityError("SCOPE_NOT_FOUND", "no publisher registered");
      if (
        binding.publisherInstanceId !== command.publisherInstanceId ||
        binding.publisherGeneration !== command.publisherGeneration ||
        binding.evidenceMode !== command.evidenceMode
      )
        throw authorityError("PUBLISHER_MISMATCH", "mode or publisher generation changed");
      if (binding.seenKeys.has(command.idempotencyKey))
        throw authorityError("IDEMPOTENCY_CONFLICT", "key already used for different bytes");
      if (
        command.sourceVersion !== binding.sourceVersion + 1 ||
        command.previousSourceCursor !== binding.sourceCursor
      )
        throw authorityError("CURSOR_DISCONTINUITY", "evidence is not the next cursor");
      binding.seenKeys.add(command.idempotencyKey);
      binding.sourceVersion = command.sourceVersion;
      binding.sourceCursor = command.sourceCursor;
      commands.push({ op: "applyCompleteSnapshot", command: command as never });
      return {
        contractVersion: 1,
        operation: "snapshot",
        idempotentReplay: false,
        committedGeneration: command.expectedGeneration + 1,
        health: {} as MembershipScopeHealth,
        memberships: [],
        revokedPrincipalIds: [],
      } satisfies MembershipMutationReceipt;
    }),
    reportIncompleteSnapshot: vi.fn(async (command) => {
      commands.push({ op: "reportIncompleteSnapshot", command: command as never });
      return {
        contractVersion: 1,
        operation: "health",
        idempotentReplay: false,
        committedGeneration: command.expectedGeneration,
        health: {} as MembershipScopeHealth,
      } satisfies MembershipMutationReceipt;
    }),
    applyMembership: vi.fn(async (command) => {
      const binding = bindings.get(
        `${command.agentId}:${command.connectorAccountId}:${command.externalRoomId}`
      );
      if (!binding) throw authorityError("SCOPE_NOT_FOUND", "no publisher registered");
      if (
        binding.publisherInstanceId !== command.publisherInstanceId ||
        binding.publisherGeneration !== command.publisherGeneration ||
        binding.evidenceMode !== command.evidenceMode
      )
        throw authorityError("PUBLISHER_MISMATCH", "mode or publisher generation changed");
      if (binding.evidenceMode === "ordered_delta" && binding.sourceVersion < 0)
        throw authorityError("SNAPSHOT_REQUIRED", "deltas need a complete baseline first");
      if (binding.seenKeys.has(command.idempotencyKey))
        throw authorityError("IDEMPOTENCY_CONFLICT", "key already used for different bytes");
      if (
        command.sourceVersion !== binding.sourceVersion + 1 ||
        command.previousSourceCursor !== binding.sourceCursor
      )
        throw authorityError("CURSOR_DISCONTINUITY", "evidence is not the next cursor");
      binding.seenKeys.add(command.idempotencyKey);
      binding.sourceVersion = command.sourceVersion;
      binding.sourceCursor = command.sourceCursor;
      commands.push({ op: "applyMembership", command: command as never });
      return {
        contractVersion: 1,
        operation: "membership",
        idempotentReplay: false,
        committedGeneration: command.expectedGeneration + 1,
        membership: {} as MembershipRecord,
      } satisfies MembershipMutationReceipt;
    }),
    setScopeHealth: vi.fn(async (command) => {
      commands.push({ op: "setScopeHealth", command: command as never });
      return {
        contractVersion: 1,
        operation: "health",
        idempotentReplay: false,
        committedGeneration: command.expectedGeneration,
        health: {} as MembershipScopeHealth,
      } satisfies MembershipMutationReceipt;
    }),
    authorize: vi.fn(async () => decision),
    getMembership: vi.fn(async () => membership),
    getScopeHealth: vi.fn(async () => scopeHealth),
    registerInvalidator: vi.fn(() => () => {}),
  } as unknown as MembershipService;
  return {
    service,
    commands,
    setScopeHealth: (health: MembershipScopeHealth | null) => {
      scopeHealth = health;
    },
  };
}

function createAuthority(
  service: MembershipService,
  runtime: IAgentRuntime = createRuntime()
): MatrixMembershipAuthority {
  return new MatrixMembershipAuthority({
    runtime,
    connectorAccountId: ACCOUNT_ID,
    service,
  });
}

/** Publishes a one-member complete baseline for ROOM on the authority. */
async function publishBaseline(authority: MatrixMembershipAuthority): Promise<void> {
  const published = await authority.publishSnapshot({
    roomId: ROOM,
    observedAt: "2026-08-26T00:00:00.000Z",
    members: [
      {
        canonicalPrincipalId: PRINCIPAL_A,
        roles: ["member"],
        permissionSnapshot: { membership: "join" },
        runtime: { worldId: null, roomId: null, entityId: PRINCIPAL_A },
      },
    ],
    idempotencyKey: "baseline-0",
  });
  expect(published).toBe(true);
}

describe("matrix membership scope and mapping", () => {
  it("scopes externalWorldId and externalRoomId to the raw Matrix room id under connector matrix", () => {
    const scope = matrixMembershipScope({
      agentId: AGENT_ID,
      connectorAccountId: ACCOUNT_ID,
      roomId: ROOM,
    });
    expect(scope.connectorId).toBe("matrix");
    expect(scope.externalWorldId).toBe(ROOM);
    expect(scope.externalRoomId).toBe(ROOM);
    expect(scope.connectorAccountId).toBe(ACCOUNT_ID);
  });

  it("maps every membership transition to the correct authority state and reason", () => {
    expect(matrixTransitionToMembership("join")).toEqual({
      state: "active",
      reason: "joined",
    });
    // An invite is not admission.
    expect(matrixTransitionToMembership("invite")).toEqual({
      state: "revoked",
      reason: "left",
    });
    expect(matrixTransitionToMembership("leave")).toEqual({
      state: "revoked",
      reason: "left",
    });
    expect(matrixTransitionToMembership("ban")).toEqual({
      state: "revoked",
      reason: "banned",
    });
  });

  it("classifies raw SDK membership strings into transitions", () => {
    expect(classifyMatrixTransition("join", undefined)).toBe<MatrixMembershipTransition>("join");
    expect(classifyMatrixTransition("invite", undefined)).toBe<MatrixMembershipTransition>(
      "invite"
    );
    expect(classifyMatrixTransition("leave", "join")).toBe<MatrixMembershipTransition>("leave");
    expect(classifyMatrixTransition("ban", "join")).toBe<MatrixMembershipTransition>("ban");
    // An unban resets membership to leave: still not active.
    expect(classifyMatrixTransition("leave", "ban")).toBe<MatrixMembershipTransition>("leave");
  });

  it("refuses to classify unknown or missing membership as a leave", () => {
    // Revoking a principal requires an explicit leave/ban decision — a
    // missing value or a valid-but-unsupported Matrix state (knock) must be
    // reported and skipped, never silently interpreted as absence.
    expect(classifyMatrixTransition(undefined, "join")).toBeNull();
    expect(classifyMatrixTransition("knock", "join")).toBeNull();
    expect(classifyMatrixTransition("future_state", undefined)).toBeNull();
  });

  it("derives roles from power levels", () => {
    expect(matrixMemberRoles(100)).toContain("owner");
    expect(matrixMemberRoles(50)).toContain("administrator");
    expect(matrixMemberRoles(0)).toEqual(["member"]);
  });

  it("matrixObservedAt never throws on missing or out-of-range timestamps", () => {
    // Lazy-loaded state events can surface without a server timestamp
    // (undefined/NaN), and a finite-but-out-of-range value (1e16 ms is
    // past the ±8.64e15 Date limit) still constructs an Invalid Date —
    // either would throw in toISOString() inside the evidence command
    // and drop the transition. The guard must fall back to wall-clock.
    expect(() => matrixObservedAt(Number.NaN)).not.toThrow();
    expect(() => matrixObservedAt(1e16)).not.toThrow();
    const wallClock = new Date("2026-08-29T00:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(wallClock);
    try {
      expect(matrixObservedAt(Number.NaN)).toBe("2026-08-29T00:00:00.000Z");
      expect(matrixObservedAt(1e16)).toBe("2026-08-29T00:00:00.000Z");
      // In-range timestamps stay deterministic — the evidence ordering
      // contract (observedAt monotonicity within a room) relies on it.
      expect(matrixObservedAt(0)).toBe("1970-01-01T00:00:00.000Z");
      expect(matrixObservedAt(8.64e15 - 1)).toBe("+275760-09-12T23:59:59.999Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MatrixMembershipAuthority snapshots", () => {
  it("publishes a complete snapshot for complete state", async () => {
    const { service, commands } = createAuthorityService();
    const authority = createAuthority(service);
    const published = await authority.publishSnapshot({
      roomId: ROOM,
      observedAt: "2026-08-26T00:00:00.000Z",
      members: [
        {
          canonicalPrincipalId: PRINCIPAL_A,
          roles: ["member"],
          permissionSnapshot: { membership: "join" },
          runtime: { worldId: null, roomId: null, entityId: PRINCIPAL_A },
        },
      ],
      idempotencyKey: `mx:${ACCOUNT_ID}:${ROOM}:prepared:first:1`,
    });
    expect(published).toBe(true);
    const snapshot = commands.find((c) => c.op === "applyCompleteSnapshot");
    expect(snapshot).toBeDefined();
    const command = snapshot?.command as
      | { completeness?: string; evidenceMode?: string; members?: unknown[] }
      | undefined;
    expect(command?.completeness).toBe("complete");
    // Single publisher mode per scope (the SQL authority requires every
    // command's mode to equal the registered mode): snapshots are the
    // complete baseline of an ordered_delta publisher.
    expect(command?.evidenceMode).toBe("ordered_delta");
    expect(command?.members?.length).toBe(1);
  });

  it("reports incomplete instead of publishing an empty roster", async () => {
    const { service, commands } = createAuthorityService();
    const authority = createAuthority(service);
    await authority.reportIncomplete({
      roomId: ROOM,
      reason: "member_list_incomplete",
      observedAt: "2026-08-26T00:00:00.000Z",
    });
    expect(commands.some((c) => c.op === "applyCompleteSnapshot")).toBe(false);
    const report = commands.find((c) => c.op === "reportIncompleteSnapshot");
    expect(report?.command.completeness).toBe("incomplete");
    expect(report?.command.reason).toBe("member_list_incomplete");
    // A room marked incomplete refuses later snapshots until complete state.
    expect(authority.isRoomIncomplete(ROOM)).toBe(true);
  });
});

describe("MatrixMembershipAuthority transitions", () => {
  it("records a join transition as ordered-delta evidence after a snapshot baseline", async () => {
    const { service, commands } = createAuthorityService();
    const authority = createAuthority(service);
    await publishBaseline(authority);
    await authority.recordTransition({
      roomId: ROOM,
      canonicalPrincipalId: PRINCIPAL_A,
      transition: "join",
      roles: ["member"],
      permissionSnapshot: {},
      runtime: { worldId: null, roomId: null, entityId: PRINCIPAL_A },
      eventId: "$m1",
      matrixUserId: "@alice:example",
      observedAt: "2026-08-26T00:00:01.000Z",
    });
    const applied = commands.find((c) => c.op === "applyMembership");
    expect(applied).toBeDefined();
    expect(applied?.command.evidenceMode).toBe("ordered_delta");
    expect(applied?.command.state).toBe("active");
    expect(applied?.command.reason).toBe("joined");
    expect(applied?.command.idempotencyKey).toContain("$m1");
  });

  it("drops a delta when no snapshot baseline exists (real authority requires one)", async () => {
    const { service, commands } = createAuthorityService();
    const authority = createAuthority(service);
    // No publishSnapshot first: the SQL authority rejects an ordered_delta
    // without a current complete baseline, so the evidence is dropped and the
    // denial stands — never a fabricated success.
    await authority.recordTransition({
      roomId: ROOM,
      canonicalPrincipalId: PRINCIPAL_A,
      transition: "join",
      roles: ["member"],
      permissionSnapshot: {},
      runtime: { worldId: null, roomId: null, entityId: PRINCIPAL_A },
      eventId: "$no-baseline",
      matrixUserId: "@alice:example",
      observedAt: "2026-08-26T00:00:01.000Z",
    });
    expect(commands.some((c) => c.op === "applyMembership")).toBe(false);
  });

  it("skips an out-of-order redelivery that would resurrect a committed revocation", async () => {
    const revoked: MembershipRecord = {
      contractVersion: 1,
      state: "revoked",
      reason: "left",
      observedAt: "2026-08-26T00:00:05.000Z",
    } as unknown as MembershipRecord;
    const { service, commands } = createAuthorityService(revoked);
    const authority = createAuthority(service);
    await authority.recordTransition({
      roomId: ROOM,
      canonicalPrincipalId: PRINCIPAL_A,
      // Same instant as the committed leave: an equal-stamp join must not
      // resurrect.
      transition: "join",
      eventId: "$old-join",
      matrixUserId: "@alice:example",
      observedAt: "2026-08-26T00:00:05.000Z",
      runtime: { worldId: null, roomId: null, entityId: PRINCIPAL_A },
    });
    expect(commands.some((c) => c.op === "applyMembership")).toBe(false);
  });

  it("terminates the scope on bot self-leave and refuses later evidence", async () => {
    const { service, commands } = createAuthorityService();
    const authority = createAuthority(service);
    await authority.markScopeUnavailable({ roomId: ROOM, reason: "bot_left" });
    // No persisted scope row exists yet: degradation is local (the tombstone
    // below); setScopeHealth only runs when there is a scope to degrade.
    const degrade = commands.find((c) => c.op === "setScopeHealth");
    expect(degrade).toBeUndefined();
    // Post-leave evidence is tombstoned.
    const published = await authority.publishSnapshot({
      roomId: ROOM,
      observedAt: "2026-08-26T00:00:10.000Z",
      members: [],
      idempotencyKey: "after-leave",
    });
    expect(published).toBe(false);
    expect(commands.some((c) => c.op === "applyCompleteSnapshot")).toBe(false);
  });
});

describe("MatrixMembershipMessageGate", () => {
  function gateWith(
    authority: MatrixMembershipAuthority | null,
    runtime = createRuntime()
  ): MatrixMembershipMessageGate {
    return new MatrixMembershipMessageGate({ runtime, authority });
  }

  it("allows direct rooms without consulting the authority", async () => {
    const { service } = createAuthorityService();
    const authorize = vi.fn();
    (service as { authorize: unknown }).authorize = authorize;
    const gate = gateWith(createAuthority(service));
    const allowed = await gate.authorizeMessage({
      roomId: ROOM,
      isDirectRoom: true,
      principalEntityId: PRINCIPAL_A,
      matrixUserId: "@alice:example",
      getJoinedMemberIds: () => [],
    });
    expect(allowed).toBe(true);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("allows group messages on an allowed authority decision", async () => {
    const { service } = createAuthorityService();
    const gate = gateWith(createAuthority(service));
    const allowed = await gate.authorizeMessage({
      roomId: ROOM,
      isDirectRoom: false,
      principalEntityId: PRINCIPAL_A,
      matrixUserId: "@alice:example",
      getJoinedMemberIds: () => ["@alice:example"],
    });
    expect(allowed).toBe(true);
  });

  it("fails closed when the authority denies and the roster does not contain the sender", async () => {
    const denied: MembershipAuthorizationDecision = {
      decision: "denied",
      reason: "no_membership",
      generation: null,
      health: null,
    };
    const { service, commands } = createAuthorityService(null, denied);
    const gate = gateWith(createAuthority(service));
    const allowed = await gate.authorizeMessage({
      roomId: ROOM,
      isDirectRoom: false,
      principalEntityId: PRINCIPAL_A,
      matrixUserId: "@alice:example",
      getJoinedMemberIds: () => ["@someone-else:example"],
    });
    expect(allowed).toBe(false);
    // Roster-miss: no reconciled evidence recorded.
    expect(commands.some((c) => c.op === "applyMembership")).toBe(false);
  });

  it("roster-miss denial never reaches the authority roster-evidence seam (review control)", async () => {
    // The suite-level double above has no publisher binding registered for
    // the room, so its applyMembership assertion passes even when the gate
    // reconciles a roster-miss: the write is swallowed into reportError and
    // the test observes the fake, not the gate. Against a real authority
    // with a live binding, a forced reconcile would fabricate a join
    // transition for a user the live roster does not contain. This control
    // observes the authority surface directly — a roster-miss denial must
    // never reach recordTransitionFromRoster.
    const recordSpy = vi.fn(async () => true);
    const authority = {
      authorize: vi.fn(async () => ({
        decision: "denied",
        reason: "no_membership",
        generation: null,
        health: null,
      })),
      recordTransitionFromRoster: recordSpy,
    } as unknown as MatrixMembershipAuthority;
    const gate = gateWith(authority);
    const allowed = await gate.authorizeMessage({
      roomId: ROOM,
      isDirectRoom: false,
      principalEntityId: PRINCIPAL_A,
      matrixUserId: "@alice:example",
      getJoinedMemberIds: () => ["@someone-else:example"],
    });
    expect(allowed).toBe(false);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("reconciles a roster-present sender and re-authorizes", async () => {
    let call = 0;
    const decisions: MembershipAuthorizationDecision[] = [
      { decision: "denied", reason: "no_membership", generation: null, health: null },
      {
        decision: "allowed",
        reason: "active_membership",
        generation: 2,
        health: "current",
        membership: {} as MembershipRecord,
      },
    ];
    const { service, commands } = createAuthorityService();
    (service as { authorize: unknown }).authorize = vi.fn(async () => decisions[call++]);
    const authority = createAuthority(service);
    await publishBaseline(authority);
    const gate = gateWith(authority);
    const allowed = await gate.authorizeMessage({
      roomId: ROOM,
      isDirectRoom: false,
      principalEntityId: PRINCIPAL_A,
      matrixUserId: "@alice:example",
      getJoinedMemberIds: () => ["@alice:example"],
    });
    expect(allowed).toBe(true);
    // The reconcile recorded reconciled_present evidence.
    const applied = commands.find((c) => c.op === "applyMembership");
    expect(applied?.command.reason).toBe("joined");
  });

  it("degrades to allow with a warning when no authority service is configured", async () => {
    const gate = gateWith(null);
    const allowed = await gate.authorizeMessage({
      roomId: ROOM,
      isDirectRoom: false,
      principalEntityId: PRINCIPAL_A,
      matrixUserId: "@alice:example",
      getJoinedMemberIds: () => [],
    });
    expect(allowed).toBe(true);
  });

  it("fails closed for every room once the gate is marked broken", async () => {
    const { service } = createAuthorityService();
    const gate = gateWith(createAuthority(service));
    gate.markBroken();
    const allowed = await gate.authorizeMessage({
      roomId: ROOM,
      isDirectRoom: false,
      principalEntityId: PRINCIPAL_A,
      matrixUserId: "@alice:example",
      getJoinedMemberIds: () => ["@alice:example"],
    });
    expect(allowed).toBe(false);
    // Direct rooms too: a configured authority that failed bootstrap must
    // never be bypassed by room shape.
    const directAllowed = await gate.authorizeMessage({
      roomId: ROOM,
      isDirectRoom: true,
      principalEntityId: PRINCIPAL_A,
      matrixUserId: "@alice:example",
      getJoinedMemberIds: () => ["@alice:example"],
    });
    expect(directAllowed).toBe(false);
  });

  it("clears a limited-sync incompleteness only for its recorded reason", async () => {
    const { service } = createAuthorityService();
    const authority = createAuthority(service);
    authority.markRoomIncomplete(ROOM, "limited_sync_timeline_reset");
    expect(authority.isRoomIncomplete(ROOM)).toBe(true);
    // A different reason must NOT clear it.
    expect(authority.clearRoomIncomplete(ROOM, "member_load_failed")).toBe(false);
    expect(authority.isRoomIncomplete(ROOM)).toBe(true);
    // The recorded reason clears it.
    expect(authority.clearRoomIncomplete(ROOM, "limited_sync_timeline_reset")).toBe(true);
    expect(authority.isRoomIncomplete(ROOM)).toBe(false);
  });

  it("fails closed locally when persisting incompleteness fails", async () => {
    const { service } = createAuthorityService();
    const authority = createAuthority(service);
    await publishBaseline(authority);
    // The authority store goes down AFTER a current baseline: the next
    // incompleteness report must still fail admission closed locally.
    let failIncomplete = false;
    const rawReport = service.reportIncompleteSnapshot as ReturnType<typeof vi.fn>;
    rawReport.mockImplementation(async () => {
      if (failIncomplete) {
        throw new Error("authority store outage");
      }
      return {
        contractVersion: 1,
        operation: "health" as const,
        idempotentReplay: false,
        committedGeneration: 1,
        health: {} as MembershipScopeHealth,
      };
    });
    failIncomplete = true;
    await authority.reportIncomplete({
      roomId: ROOM,
      reason: "member_list_incomplete",
      observedAt: "2026-08-26T00:05:00.000Z",
    });
    failIncomplete = false;
    expect(authority.isRoomIncomplete(ROOM)).toBe(true);
    // The underlying authority would still say allowed — the LOCAL incomplete
    // flag must fail the room closed anyway (ss251 review control).
    const decision = await authority.authorize({
      roomId: ROOM,
      canonicalPrincipalId: PRINCIPAL_A,
    });
    expect(decision.decision).toBe("denied");
    expect(decision.reason).toBe("authority_stale");
    // Recovery: a complete snapshot clears the flag and reopens admission.
    const ok = await authority.publishSnapshot({
      roomId: ROOM,
      observedAt: "2026-08-26T00:10:00.000Z",
      members: [
        {
          canonicalPrincipalId: PRINCIPAL_A,
          roles: ["member"],
          permissionSnapshot: { membership: "join" },
          runtime: { worldId: null, roomId: null, entityId: PRINCIPAL_A },
        },
      ],
      idempotencyKey: "recovery-after-failed-incomplete",
    });
    expect(ok).toBe(true);
    expect(authority.isRoomIncomplete(ROOM)).toBe(false);
    const after = await authority.authorize({
      roomId: ROOM,
      canonicalPrincipalId: PRINCIPAL_A,
    });
    expect(after.decision).toBe("allowed");
  });

  it("an authorize queued behind a failing reportIncomplete is denied (no TOCTOU)", async () => {
    const { service } = createAuthorityService();
    const authority = createAuthority(service);
    await publishBaseline(authority);
    let releaseReport: (() => void) | undefined;
    let fail = false;
    const rawReport = service.reportIncompleteSnapshot as ReturnType<typeof vi.fn>;
    rawReport.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          if (!fail) {
            resolve({
              contractVersion: 1,
              operation: "health" as const,
              idempotentReplay: false,
              committedGeneration: 1,
              health: {} as MembershipScopeHealth,
            });
            return;
          }
          releaseReport = () => reject(new Error("authority store outage"));
        })
    );
    // Start reportIncomplete and pause its storage call while it HOLDS the
    // serialized scope chain.
    fail = true;
    const reporting = authority.reportIncomplete({
      roomId: ROOM,
      reason: "member_list_incomplete",
      observedAt: "2026-08-26T00:05:00.000Z",
    });
    await new Promise((r) => setTimeout(r, 10));
    // Queue an authorize behind the in-flight report. The incomplete flag is
    // not set yet — the pre-serialization state RP flagged as a TOCTOU gap.
    const authorizing = authority.authorize({
      roomId: ROOM,
      canonicalPrincipalId: PRINCIPAL_A,
    });
    await new Promise((r) => setTimeout(r, 10));
    // The report's persist fails: it must set the local flag before releasing
    // the chain, so the queued authorize — running AFTER it — must see it.
    releaseReport?.();
    await reporting;
    const decision = await authorizing;
    expect(authority.isRoomIncomplete(ROOM)).toBe(true);
    expect(decision.decision).toBe("denied");
    expect(decision.reason).toBe("authority_stale");
  });

  it("fails closed when no authority is configured but enforcement is strict", async () => {
    process.env.MATRIX_MEMBERSHIP_ENFORCE = "1";
    try {
      const gate = gateWith(null);
      const allowed = await gate.authorizeMessage({
        roomId: ROOM,
        isDirectRoom: false,
        principalEntityId: PRINCIPAL_A,
        matrixUserId: "@alice:example",
        getJoinedMemberIds: () => [],
      });
      expect(allowed).toBe(false);
    } finally {
      delete process.env.MATRIX_MEMBERSHIP_ENFORCE;
    }
  });
});

describe("MatrixMembershipAuthority fencing", () => {
  function fencedService(fenceError: Error & { code?: string }) {
    const { service, commands } = createAuthorityService();
    let calls = 0;
    (service as { applyMembership: unknown }).applyMembership = vi.fn(async (command) => {
      calls += 1;
      if (calls === 1) throw fenceError;
      commands.push({ op: "applyMembership", command: command as never });
      return {
        contractVersion: 1,
        operation: "membership",
        idempotentReplay: false,
        committedGeneration: command.expectedGeneration + 1,
        membership: {} as MembershipRecord,
      } satisfies MembershipMutationReceipt;
    });
    return { service, commands };
  }

  it("re-adopts after a cursor-discontinuity fence failure and commits", async () => {
    const fenceError = new Error("MEMBERSHIP_CURSOR_DISCONTINUITY");
    fenceError.code = "MEMBERSHIP_CURSOR_DISCONTINUITY";
    const { service, commands } = fencedService(fenceError);
    const authority = createAuthority(service);
    await authority.recordTransition({
      roomId: ROOM,
      canonicalPrincipalId: PRINCIPAL_A,
      transition: "join",
      eventId: "$fenced",
      matrixUserId: "@alice:example",
      observedAt: "2026-08-26T00:00:02.000Z",
      runtime: { worldId: null, roomId: null, entityId: PRINCIPAL_A },
    });
    expect(commands.some((c) => c.op === "applyMembership")).toBe(true);
  });

  it("treats an idempotency conflict as a benign duplicate", async () => {
    const { service, commands } = createAuthorityService();
    const conflict = new Error("MEMBERSHIP_IDEMPOTENCY_CONFLICT");
    conflict.code = "MEMBERSHIP_IDEMPOTENCY_CONFLICT";
    (service as { applyMembership: unknown }).applyMembership = vi.fn(async () => {
      throw conflict;
    });
    const authority = createAuthority(service);
    await authority.recordTransition({
      roomId: ROOM,
      canonicalPrincipalId: PRINCIPAL_A,
      transition: "join",
      eventId: "$dup",
      matrixUserId: "@alice:example",
      observedAt: "2026-08-26T00:00:03.000Z",
      runtime: { worldId: null, roomId: null, entityId: PRINCIPAL_A },
    });
    // Benign duplicate: no evidence command committed, not thrown.
    expect(commands.some((c) => c.op === "applyMembership")).toBe(false);
  });
});

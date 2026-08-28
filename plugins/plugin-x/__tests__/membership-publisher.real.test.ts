/**
 * Real-PGlite coverage for the X DM membership publisher (#24372):
 * account-scoped observed-only evidence through the landed core
 * MembershipService + plugin-sql authority, join/leave semantics for group
 * and 1:1 conversations, own-account participation, idempotent redelivery
 * of event-anchored proofs, scope isolation, degradation fail-closed, and
 * per-scope serialization. The runtime, adapter, connector-account row, and
 * authority are all real; only the X DM timeline events are synthetic.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  type MembershipAuthorizationDecision,
  type MembershipScope,
  MembershipService,
  type UUID,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { XMembershipPublisher, xMembershipPrincipal } from "../src/membership";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

let runtime: AgentRuntime;
let membership: MembershipService;
let publisher: XMembershipPublisher;
let restartDir: string;

const OWN_USER_ID = "990000000000000001";

async function scopeFor(conversationId: string): Promise<MembershipScope> {
  const scope = await publisher.scopeForConversation({
    conversationId,
    accountKey: "default",
    ownUserId: OWN_USER_ID,
  });
  if (!scope) {
    throw new Error("membership scope resolution failed (publisher null)");
  }
  return scope;
}

beforeAll(async () => {
  restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-membership-24372-"));
  // The membership authority validates UUID version nibbles, so the test
  // agent id must be a real v4. Build the runtime directly over a real
  // PGlite adapter, the same shape plugin-sql's own authority tests use.
  const agentId = randomUUID() as UUID;
  const adapter = createDatabaseAdapter({ dataDir: restartDir }, agentId);
  await (adapter as unknown as { init: () => Promise<void> }).init();
  runtime = new AgentRuntime({
    character: {
      name: "x-membership-24372",
      id: agentId,
      plugins: [],
      settings: {},
    },
    agentId,
    adapter,
    logLevel: "warn",
    enableAutonomy: false,
  });
  // plugin-sql registers SqlMembershipService; import via the source alias
  // the real-runtime config provides so the DB schema is the real one.
  const sqlModule = (await import("@elizaos/plugin-sql")) as {
    default?: { plugins?: unknown[] };
    plugin?: { plugins?: unknown[] };
  };
  const sqlPlugin =
    sqlModule.default ??
    (sqlModule.plugin as { plugins?: unknown[] } | undefined);
  if (sqlPlugin) {
    await runtime.registerPlugin(
      sqlPlugin as unknown as Parameters<AgentRuntime["registerPlugin"]>[0],
    );
  }
  await runtime.initialize();
  const services = runtime.getServicesByType<MembershipService>(
    MembershipService.serviceType,
  );
  expect(services.length).toBeGreaterThan(0);
  membership = services[0];
  publisher = new XMembershipPublisher(runtime);
  cleanups.push(async () => {
    await runtime.stop();
  });
}, 180_000);

afterAll(async () => {
  fs.rmSync(restartDir, { recursive: true, force: true });
}, 60_000);

describe("X membership publisher (real PGlite authority)", () => {
  it("upserts a durable UUID connector account and derives a stable account-scoped scope", async () => {
    const scopeA = await scopeFor("199988877766655");
    const scopeB = await scopeFor("199988877766655");
    expect(scopeA).toEqual(scopeB);
    expect(scopeA.connectorId).toBe("x");
    // The authority requires a UUID connector account id; "default" is not one.
    expect(scopeA.connectorAccountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("scopes are account-scoped: a second X user id derives a different connectorAccountId", async () => {
    const scopeA = await publisher.scopeForConversation({
      conversationId: "199988877766655",
      accountKey: "default",
      ownUserId: OWN_USER_ID,
    });
    const scopeB = await publisher.scopeForConversation({
      conversationId: "199988877766655",
      accountKey: "second-account",
      ownUserId: "990000000000000002",
    });
    expect(scopeA).not.toBeNull();
    expect(scopeB).not.toBeNull();
    expect(scopeA?.connectorAccountId).not.toEqual(scopeB?.connectorAccountId);
  });

  it("publishes a sender renewal as active point-query evidence that authorizes", async () => {
    const conversationId = "1999888777660001";
    const scope = await scopeFor(conversationId);
    const { principalId: principal } = await xMembershipPrincipal(
      runtime,
      "default",
      "7001",
    );
    await publisher.renewSender({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `renew:${conversationId}:7001:e${Date.now()}`,
    });
    const decision: MembershipAuthorizationDecision =
      await membership.authorize(scope, principal);
    expect(decision.decision).toBe("allowed");
    expect(decision.reason).toBe("active_membership");
    const record = await membership.getMembership(scope, principal);
    expect(record?.state).toBe("active");
    expect(record?.reason).toBe("reconciled_present");
    expect(record?.evidenceMode).toBe("point_query");
  });

  it("join and leave observations transition the same principal with idempotent redelivery", async () => {
    const conversationId = "1999888777660002";
    const scope = await scopeFor(conversationId);
    const { principalId: principal } = await xMembershipPrincipal(
      runtime,
      "default",
      "7002",
    );
    await publisher.publishJoin({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: "x:join:1999888777660002:7002:e900100",
      eventAnchoredAt: 1_756_000_000_000,
    });
    let record = await membership.getMembership(scope, principal);
    expect(record?.state).toBe("active");
    expect(record?.reason).toBe("joined");

    // Redelivery of the same event under the same key is a benign replay:
    // the publish must not throw and must not corrupt the chain.
    await publisher.publishJoin({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: "x:join:1999888777660002:7002:e900100",
      eventAnchoredAt: 1_756_000_000_000,
    });
    record = await membership.getMembership(scope, principal);
    expect(record?.state).toBe("active");

    await publisher.publishLeave({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      reason: "left",
      idempotencyKey: "x:left:1999888777660002:7002:e900101",
      eventAnchoredAt: 1_756_000_001_000,
    });
    record = await membership.getMembership(scope, principal);
    expect(record?.state).toBe("revoked");
    expect(record?.reason).toBe("left");

    const decision = await membership.authorize(scope, principal);
    expect(decision.decision).toBe("denied");
    expect(decision.reason).toBe("membership_revoked");
  });

  it("isolates membership per conversation: a leave in one scope never revokes another", async () => {
    const conversationA = "1999888777660003";
    const conversationB = "1999888777660004";
    const scopeA = await scopeFor(conversationA);
    const scopeB = await scopeFor(conversationB);
    const { principalId: principal } = await xMembershipPrincipal(
      runtime,
      "default",
      "7003",
    );
    for (const scope of [scopeA, scopeB]) {
      await publisher.publishJoin({
        scope,
        principalId: principal,
        worldId: runtime.agentId,
        roomId: runtime.agentId,
        roles: ["participant"],
        permissionSnapshot: { observed: true },
        idempotencyKey: `x:join:${scope.externalRoomId}:7003:e900200`,
        eventAnchoredAt: 1_756_000_002_000,
      });
    }
    await publisher.publishLeave({
      scope: scopeA,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      reason: "left",
      idempotencyKey: `x:left:${conversationA}:7003:e900201`,
      eventAnchoredAt: 1_756_000_003_000,
    });
    const denied = await membership.authorize(scopeA, principal);
    expect(denied.decision).toBe("denied");
    const allowed = await membership.authorize(scopeB, principal);
    expect(allowed.decision).toBe("allowed");
  });

  it("degrades a scope explicitly and fails authorization closed while degraded", async () => {
    const conversationId = "1999888777660005";
    const scope = await scopeFor(conversationId);
    const { principalId: principal } = await xMembershipPrincipal(
      runtime,
      "default",
      "7004",
    );
    await publisher.publishJoin({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:join:${conversationId}:7004:e900300`,
      eventAnchoredAt: 1_756_000_004_000,
    });
    await publisher.degradeScope({
      scope,
      health: "unavailable",
      reason: "own_account_removed_from_conversation",
    });
    const decision = await membership.authorize(scope, principal);
    expect(decision.decision).toBe("denied");
    expect(decision.reason).toBe("authority_unavailable");
  });

  it("restores a degraded scope by re-registering and re-proving on activity", async () => {
    const conversationId = "1999888777660006";
    const scope = await scopeFor(conversationId);
    const { principalId: principal } = await xMembershipPrincipal(
      runtime,
      "default",
      "7005",
    );
    await publisher.publishJoin({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:join:${conversationId}:7005:e900400`,
      eventAnchoredAt: 1_756_000_005_000,
    });
    await publisher.degradeScope({
      scope,
      health: "unavailable",
      reason: "own_account_removed_from_conversation",
    });
    const degraded = await membership.authorize(scope, principal);
    expect(degraded.decision).toBe("denied");
    expect(degraded.reason).toBe("authority_unavailable");
    await publisher.restoreScope({
      scope,
      reason: "account_regained_conversation_access",
    });
    // Re-prove on the next observed activity after restoration.
    await publisher.renewSender({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:renew:${conversationId}:7005:e900401`,
    });
    const decision = await membership.authorize(scope, principal);
    expect(decision.decision).toBe("allowed");
    expect(decision.reason).toBe("active_membership");
  });

  it("serializes concurrent observations for one scope without cursor races", async () => {
    const conversationId = "1999888777660007";
    const scope = await scopeFor(conversationId);
    const principals = await Promise.all(
      ["7101", "7102", "7103", "7104", "7105"].map((xId) =>
        xMembershipPrincipal(runtime, "default", xId).then(
          (r) => r.principalId,
        ),
      ),
    );
    const results = await Promise.all(
      principals.map((principalId, index) =>
        publisher.publishJoin({
          scope,
          principalId,
          worldId: runtime.agentId,
          roomId: runtime.agentId,
          roles: ["participant"],
          permissionSnapshot: { observed: true, slot: index },
          idempotencyKey: `x:join:${conversationId}:${principals[index]}:e9005${index}`,
          eventAnchoredAt: 1_756_000_006_000 + index,
        }),
      ),
    );
    expect(results).toHaveLength(5);
    const decisions = await Promise.all(
      principals.map((principalId) => membership.authorize(scope, principalId)),
    );
    for (const decision of decisions) {
      expect(decision.decision).toBe("allowed");
    }
  });

  it("publishes distinct principals per account for the same X user id (account-scoped ids)", async () => {
    const defaultPrincipal = await xMembershipPrincipal(
      runtime,
      "default",
      "7200",
    );
    const secondPrincipal = await xMembershipPrincipal(
      runtime,
      "second-account",
      "7200",
    );
    expect(defaultPrincipal.principalId).not.toEqual(
      secondPrincipal.principalId,
    );
    // Both principals are valid v5 UUIDs the authority accepts.
    for (const principal of [
      defaultPrincipal.principalId,
      secondPrincipal.principalId,
    ]) {
      expect(principal).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    }
  });

  it("survives a restart: a new publisher instance ADOPTS the durable binding (same generation) and re-proves", async () => {
    const conversationId = "1999888777660008";
    const scope = await scopeFor(conversationId);
    const { principalId: principal } = await xMembershipPrincipal(
      runtime,
      "default",
      "7300",
    );
    await publisher.publishJoin({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:join:${conversationId}:7300:e900600`,
      eventAnchoredAt: 1_756_000_007_000,
    });
    const before = await membership.getScopeHealth(scope);
    expect(before).not.toBeNull();
    const beforeState = publisher.scopeState(scope);
    expect(beforeState).toBeDefined();

    // Simulate a restart: a brand-new publisher over the same runtime. The
    // stable per-(agent, account) publisher id must take the ADOPTION path —
    // generation, cursor, and version preserved, not bumped. The adoption
    // happens at first use (renewSender); capture the durable state right
    // after that call and require EXACT generation equality.
    const reborn = new XMembershipPublisher(runtime);
    const rebornScope = await reborn.scopeForConversation({
      conversationId,
      accountKey: "default",
      ownUserId: OWN_USER_ID,
    });
    expect(rebornScope).toEqual(scope);
    await reborn.renewSender({
      scope: rebornScope ?? scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:renew:${conversationId}:7300:e900601`,
    });
    const after = await membership.getScopeHealth(scope);
    expect(after).not.toBeNull();
    // Adoption invariant: the authority bumps `generation` on every committed
    // command (registration=+1, each evidence=+1), so a restart that adopts
    // and re-proves must show EXACTLY one new commit — generation
    // before+1 — with the publisher seat UNCHANGED (same publisherInstanceId
    // and same publisherGeneration). A takeover would bump publisherGeneration
    // and add a second generation step (re-register + commit).
    if (before && after) {
      expect(after.generation).toBe(before.generation + 1);
      expect(after.publisherInstanceId).toBe(before.publisherInstanceId);
      expect(after.publisherGeneration).toBe(before.publisherGeneration);
      expect(after.sourceVersion).toBe(before.sourceVersion + 1);
    }
    const decision = await membership.authorize(scope, principal);
    expect(decision.decision).toBe("allowed");
    expect(decision.reason).toBe("active_membership");
  });

  it("serializes a concurrent renew→leave→renew sequence without a stale renewal window", async () => {
    const conversationId = "1999888777660012";
    const scope = await scopeFor(conversationId);
    const { principalId: principal } = await xMembershipPrincipal(
      runtime,
      "default",
      "7600",
    );
    await publisher.publishJoin({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:join:${conversationId}:7600:e900900`,
      eventAnchoredAt: 1_756_000_012_000,
    });
    // Fire renewal, leave, and a fresh observation CONCURRENTLY: per-scope
    // serialization plus removeRenewalOnCommit must leave the principal
    // re-proved active (the last observation wins inside the queue), never
    // suppressed by a stale renewal-window timestamp written after the
    // leave's revocation.
    await Promise.allSettled([
      publisher.renewSender({
        scope,
        principalId: principal,
        worldId: runtime.agentId,
        roomId: runtime.agentId,
        roles: ["participant"],
        permissionSnapshot: { observed: true },
        idempotencyKey: `x:renew:${conversationId}:7600:e900901`,
        eventAnchoredAt: 1_756_000_013_000,
      }),
      publisher.publishLeave({
        scope,
        principalId: principal,
        worldId: runtime.agentId,
        roomId: runtime.agentId,
        reason: "left",
        idempotencyKey: `x:left:${conversationId}:7600:e900902`,
        eventAnchoredAt: 1_756_000_014_000,
      }),
      publisher.renewSender({
        scope,
        principalId: principal,
        worldId: runtime.agentId,
        roomId: runtime.agentId,
        roles: ["participant"],
        permissionSnapshot: { observed: true },
        idempotencyKey: `x:renew:${conversationId}:7600:e900903`,
        eventAnchoredAt: 1_756_000_015_000,
      }),
    ]);
    // Post-leave observation activity re-proves the principal: the record
    // reflects the LAST serialized observation, not a suppressed renewal.
    const record = await membership.getMembership(scope, principal);
    expect(record?.state).toBe("active");
    expect(record?.reason).toBe("reconciled_present");
  });

  it("leave removes the renewal window at commit so the next observation re-proves immediately", async () => {
    const conversationId = "1999888777660009";
    const scope = await scopeFor(conversationId);
    const { principalId: principal } = await xMembershipPrincipal(
      runtime,
      "default",
      "7400",
    );
    await publisher.publishJoin({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:join:${conversationId}:7400:e900700`,
      eventAnchoredAt: 1_756_000_008_000,
    });
    await publisher.publishLeave({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      reason: "left",
      idempotencyKey: `x:left:${conversationId}:7400:e900701`,
      eventAnchoredAt: 1_756_000_009_000,
    });
    // A renewal queued AFTER the leave (activity observed post-revocation)
    // must not be suppressed by a stale renewal-window entry: the member
    // re-proves active immediately.
    await publisher.renewSender({
      scope,
      principalId: principal,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:renew:${conversationId}:7400:e900702`,
    });
    const record = await membership.getMembership(scope, principal);
    expect(record?.state).toBe("active");
    expect(record?.reason).toBe("reconciled_present");
  });

  it("degrades all scopes for the account and restores them (auth failure and recovery)", async () => {
    const conversationA = "1999888777660010";
    const conversationB = "1999888777660011";
    const scopeA = await scopeFor(conversationA);
    const scopeB = await scopeFor(conversationB);
    const { principalId: principalA } = await xMembershipPrincipal(
      runtime,
      "default",
      "7500",
    );
    const { principalId: principalB } = await xMembershipPrincipal(
      runtime,
      "default",
      "7501",
    );
    await publisher.publishJoin({
      scope: scopeA,
      principalId: principalA,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:join:${conversationA}:7500:e900800`,
      eventAnchoredAt: 1_756_000_010_000,
    });
    await publisher.publishJoin({
      scope: scopeB,
      principalId: principalB,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:join:${conversationB}:7501:e900801`,
      eventAnchoredAt: 1_756_000_011_000,
    });
    await publisher.degradeAllScopes("x_auth_failed_401");
    for (const [scope, principal] of [
      [scopeA, principalA],
      [scopeB, principalB],
    ] as const) {
      const denied = await membership.authorize(scope, principal);
      expect(denied.decision).toBe("denied");
      expect(denied.reason).toBe("authority_unavailable");
    }
    await publisher.restoreAllScopes("x_auth_recovered");
    // Re-prove on the next observed activity after restoration.
    await publisher.renewSender({
      scope: scopeA,
      principalId: principalA,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      roles: ["participant"],
      permissionSnapshot: { observed: true },
      idempotencyKey: `x:renew:${conversationA}:7500:e900802`,
    });
    const allowed = await membership.authorize(scopeA, principalA);
    expect(allowed.decision).toBe("allowed");
  });
});

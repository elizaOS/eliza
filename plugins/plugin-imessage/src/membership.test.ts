/**
 * Real-PGlite coverage for the native iMessage membership publisher
 * (#24370): chat_handle_join-derived complete roster snapshots through the
 * landed core MembershipService + plugin-sql authority, per-sender point
 * renewals, fail-closed roster degradation (TCC/db errors → unavailable
 * scope health → denied authorization), idempotent replay of identical
 * roster reads, and restart adoption of the durable publisher binding.
 * The runtime, adapter, connector-account row, and authority are all real;
 * only the chat.db roster source is synthetic.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  type MembershipScope,
  MembershipService,
  type UUID,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  IMessageMembershipPublisher,
  type IMessageMembershipRosterSource,
  type IMessageRosterRead,
  imessageMembershipPrincipalId,
  imessageMembershipScope,
} from "./membership.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

let runtime: AgentRuntime;
let membership: MembershipService;
let publisher: IMessageMembershipPublisher;
let connectorAccountId: UUID;
let restartDir: string;

/**
 * Synthetic chat.db roster source. Real chat.db reads are covered by the
 * plugin's integration tests over an actual SQLite fixture; the authority
 * path is what needs the real database here.
 */
class SyntheticRosterSource implements IMessageMembershipRosterSource {
  private chats = new Map<
    string,
    { chatType: "direct" | "group"; handles: string[] }
  >();
  private counter = 0;
  failure: Error | null = null;

  setChat(
    chatId: string,
    chatType: "direct" | "group",
    handles: string[],
  ): void {
    this.chats.set(chatId, { chatType, handles });
  }

  listChatIds(): readonly string[] {
    if (this.failure) throw this.failure;
    return [...this.chats.keys()];
  }

  readRoster(chatId: string): IMessageRosterRead | null {
    if (this.failure) throw this.failure;
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    // Mirror the real adapter: every read stamps a fresh monotonic cursor so
    // repeated sweeps of the same roster are distinct evidence observations.
    this.counter += 1;
    return {
      chatId,
      chatType: chat.chatType,
      displayName: chat.chatType === "group" ? `group-${chatId}` : null,
      participants: chat.handles.map((handle) => ({
        handle,
        service: "iMessage",
      })),
      cursor: this.counter,
    };
  }
}

async function scopeFor(chatId: string): Promise<MembershipScope> {
  return imessageMembershipScope({
    agentId: runtime.agentId,
    connectorAccountId,
    chatId,
  });
}

beforeAll(async () => {
  restartDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "imessage-membership-24370-"),
  );
  // The membership authority validates UUID version nibbles, so the test
  // agent id must be a real v4. Build the runtime directly over a real
  // PGlite adapter, the same shape plugin-sql's own authority tests use.
  const agentId = uuidv4() as UUID;
  const adapter = createDatabaseAdapter({ dataDir: restartDir }, agentId);
  await (adapter as unknown as { init: () => Promise<void> }).init();
  runtime = new AgentRuntime({
    character: {
      name: "imessage-membership-24370",
      id: agentId,
      plugins: [],
      settings: {},
    },
    agentId,
    adapter,
    logLevel: "warn",
    enableAutonomy: false,
  });
  const sqlModule = (await import("@elizaos/plugin-sql")) as {
    default?: { plugins?: unknown[] };
    plugin?: { plugins?: unknown[] };
  };
  const sqlPlugin =
    sqlModule.default ?? (sqlModule.plugin as { plugins?: unknown[] });
  if (sqlPlugin) {
    await runtime.registerPlugin(
      sqlPlugin as Parameters<AgentRuntime["registerPlugin"]>[0],
    );
  }
  await runtime.initialize();
  const services = runtime.getServicesByType<MembershipService>(
    MembershipService.serviceType,
  );
  expect(services.length).toBeGreaterThan(0);
  membership = services[0];

  // Bootstrap the durable connector account row exactly the way the
  // service's initMembership does (upsert through the account manager).
  const { getConnectorAccountManager } = await import("@elizaos/core");
  const manager = getConnectorAccountManager(runtime);
  const now = Date.now();
  const stored = await manager.upsertAccount("imessage", {
    id: "imessage-default",
    provider: "imessage",
    label: "iMessage (local Apple account)",
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    createdAt: now,
    updatedAt: now,
    metadata: { source: "imessage-membership" },
  });
  expect(stored.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  connectorAccountId = stored.id as UUID;

  publisher = new IMessageMembershipPublisher({
    runtime,
    connectorAccountId,
    accountKey: "default",
    service: membership,
  });
  cleanups.push(async () => {
    await runtime.stop();
  });
}, 180_000);

afterAll(async () => {
  fs.rmSync(restartDir, { recursive: true, force: true });
}, 60_000);

describe("iMessage membership publisher (real PGlite authority)", () => {
  it("derives pattern-valid deterministic principals from handles", () => {
    const a = imessageMembershipPrincipalId("default", "+15550001111");
    const b = imessageMembershipPrincipalId("default", "+15550001111");
    const c = imessageMembershipPrincipalId("default", "+15550002222");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("publishes a complete roster snapshot and admits its members", async () => {
    const source = new SyntheticRosterSource();
    source.setChat("Imessage;-;+15550001111", "direct", ["+15550001111"]);
    source.setChat("Imessage;+;chat-1;+15550002222", "group", [
      "+15550001111",
      "+15550002222",
      "+15550003333",
    ]);

    const published = await publisher.sweepRoster(source);
    expect(published).toBe(2);

    const scope = await scopeFor("Imessage;+;chat-1;+15550002222");
    for (const handle of ["+15550001111", "+15550002222", "+15550003333"]) {
      const decision = await membership.authorize(
        scope,
        imessageMembershipPrincipalId("default", handle),
      );
      expect(decision.decision).toBe("allowed");
    }

    // A handle not in the roster must be denied: the roster is the truth.
    const outsider = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550009999"),
    );
    expect(outsider.decision).toBe("denied");
  });

  it("revokes members removed from the roster on the next sweep", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;+;chat-2;+15550004444";
    source.setChat(chatId, "group", ["+15550004444", "+15550005555"]);
    await publisher.sweepRoster(source);

    // Kicked from the group: the next roster read omits the handle.
    source.setChat(chatId, "group", ["+15550004444"]);
    await publisher.sweepRoster(source);

    const scope = await scopeFor(chatId);
    const removed = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550005555"),
    );
    expect(removed.decision).toBe("denied");
    const kept = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550004444"),
    );
    expect(kept.decision).toBe("allowed");
  });

  it("degrades fail-closed when the roster source fails (TCC/DB error)", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;-;+15550006666";
    source.setChat(chatId, "direct", ["+15550006666"]);
    await publisher.sweepRoster(source);

    // Simulate a Full Disk Access revocation: reads start throwing.
    source.failure = new Error("SQLITE_CANTOPEN: disk I/O error (TCC denied)");
    await expect(publisher.sweepRoster(source)).rejects.toThrow();

    // Scope health must now be unavailable and authorization must DENY.
    const scope = await scopeFor(chatId);
    const health = await membership.getScopeHealth(scope);
    expect(health?.health).toBe("unavailable");
    const decision = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550006666"),
    );
    expect(decision.decision).toBe("denied");

    // Recovery: reads succeed again and a complete snapshot restores admission.
    source.failure = null;
    const restored = await publisher.sweepRoster(source);
    expect(restored).toBeGreaterThanOrEqual(1);
    const after = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550006666"),
    );
    expect(after.decision).toBe("allowed");
  });

  it("renews a sender with point evidence between sweeps", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;-;+15550007777";
    source.setChat(chatId, "direct", ["+15550007777"]);
    await publisher.sweepRoster(source);

    const scope = await scopeFor(chatId);
    const before = await membership.getMembership(
      scope,
      imessageMembershipPrincipalId("default", "+15550007777"),
    );
    expect(before?.state).toBe("active");

    // Within the renewal window the same sender is not re-proven: the sweep
    // just stamped this principal, so the in-process gate dedupes the
    // inbound-message renewal (the authoritative refresh path is the sweep).
    const tooSoon = await publisher.renewSender({
      chatId,
      handle: "+15550007777",
    });
    expect(tooSoon).toBe(false);

    // A renewed principal is still admitted: the committed snapshot evidence
    // carries the authorization, not the in-memory renewal map.
    const decision = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550007777"),
    );
    expect(decision.decision).toBe("allowed");
  });

  it("adopts the durable publisher binding across restarts (new instance, same scope state)", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;+;chat-3;+15550008888";
    source.setChat(chatId, "group", ["+15550008888"]);
    await publisher.sweepRoster(source);

    // A restarted process: brand-new publisher instance over the same
    // durable authority state. It must re-publish without losing the
    // committed member facts (no membership_evidence_mismatch denials).
    const restarted = new IMessageMembershipPublisher({
      runtime,
      connectorAccountId,
      accountKey: "default",
      service: membership,
    });
    const published = await restarted.sweepRoster(source);
    expect(published).toBeGreaterThanOrEqual(1);

    const scope = await scopeFor(chatId);
    const decision = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550008888"),
    );
    expect(decision.decision).toBe("allowed");
  });
});

/**
 * RP R1 follow-up coverage (fix loop): the failure semantics the first
 * review found missing — real-reader roster failures surfaced through the
 * failure counter (not a synthetic throw), restart-safe idempotency keys
 * (fresh publisher over the same durable state re-publishes instead of
 * conflicting), renewal keys that do not collide across observations, and
 * the outbound send gate consulting both the local degraded flag and
 * authority evidence.
 */
describe("iMessage membership failure semantics (RP R1 fixes)", () => {
  it("restart adoption re-publishes without idempotency conflicts across instances", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;+;chat-restart-1;+155****9001";
    source.setChat(chatId, "group", ["+155****9001", "+155****9002"]);
    await publisher.sweepRoster(source);

    // A restarted process over the same durable authority state: every
    // observation must journal a fresh idempotency key (counter resets are
    // irrelevant; the observation identity carries the key).
    const restarted = new IMessageMembershipPublisher({
      runtime,
      connectorAccountId,
      accountKey: "default",
      service: membership,
    });
    const published = await restarted.sweepRoster(source);
    expect(published).toBeGreaterThanOrEqual(1);

    const scope = await scopeFor(chatId);
    for (const handle of ["+155****9001", "+155****9002"]) {
      const decision = await membership.authorize(
        scope,
        imessageMembershipPrincipalId("default", handle),
      );
      expect(decision.decision).toBe("allowed");
    }
  });

  it("repeated renewals of the same sender commit instead of silently conflicting", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;-;+155****9011";
    source.setChat(chatId, "direct", ["+155****9011"]);
    await publisher.sweepRoster(source);

    // Backdate the renewal stamp left by the sweep so the first renewal is
    // outside the dedupe window and commits.
    const internal = (
      publisher as unknown as {
        scopes: Map<string, { renewedAt: Map<string, number> }>;
      }
    ).scopes;
    const tracker = internal.get(`${connectorAccountId}:${chatId}`);
    expect(tracker).toBeDefined();
    tracker?.renewedAt.set(
      imessageMembershipPrincipalId("default", "+155****9011") as string,
      Date.now() - 60 * 60 * 1000,
    );
    const first = await publisher.renewSender({
      chatId,
      handle: "+155****9011",
    });
    expect(first).toBe(true);

    // A later renewal (fresh observation, new cursor/timestamp digest) must
    // not be dropped by a reused permanent idempotency key: force the
    // window to expire again by backdating the in-process renewal stamp.
    tracker?.renewedAt.set(
      imessageMembershipPrincipalId("default", "+155****9011") as string,
      Date.now() - 60 * 60 * 1000,
    );
    const second = await publisher.renewSender({
      chatId,
      handle: "+155****9011",
    });
    expect(second).toBe(true);
  });

  it("a degraded scope denies authorizeSend even before the durable commit lands", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;-;+155****9021";
    source.setChat(chatId, "direct", ["+155****9021"]);
    await publisher.sweepRoster(source);

    // Deny through the gate before any durable degradation commit: mark the
    // scope degraded in-process (simulating a setScopeHealth failure).
    const internal = (
      publisher as unknown as {
        scopes: Map<string, { degraded: boolean }>;
      }
    ).scopes;
    const tracker = internal.get(`${connectorAccountId}:${chatId}`);
    expect(tracker).toBeDefined();
    if (tracker) tracker.degraded = true;

    // The local flag is consulted first: the send gate denies without
    // trusting possibly-stale authority evidence.
    const allowed = await publisher.authorizeSend({
      chatId,
      handle: "+155****9021",
    });
    expect(allowed).toBe(false);

    // Outbound gate over the bare handle resolves the direct chat and also denies.
    const outbound = await publisher.authorizeOutbound("+155****9021");
    expect(outbound).toBe(false);

    if (tracker) tracker.degraded = false;
  });

  it("authorizeOutbound returns null for ungoverned targets and true for healthy governed ones", async () => {
    const source = new SyntheticRosterSource();
    const directId = "Imessage;-;+155****9031";
    const groupId = "Imessage;+;chat-gov-1;+155****9031";
    source.setChat(directId, "direct", ["+155****9031"]);
    source.setChat(groupId, "group", ["+155****9031", "+155****9032"]);
    await publisher.sweepRoster(source);

    // Ungoverned target: legacy null (no gate).
    expect(await publisher.authorizeOutbound("+155****9999")).toBeNull();

    // Governed direct target: recipient principal is an active member.
    expect(await publisher.authorizeOutbound("+155****9031")).toBe(true);

    // Governed group target by chat id: scope health is current.
    expect(await publisher.authorizeOutbound(groupId)).toBe(true);

    // A member removed by the next complete snapshot loses admission.
    source.setChat(directId, "direct", ["+155****9034"]);
    await publisher.sweepRoster(source);
    expect(await publisher.authorizeOutbound("+155****9031")).toBe(false);
  });

  it("degradePersistedScopes marks an inventory fail-closed for restart-without-chat.db", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;+;chat-restart-2;+155****9041";
    source.setChat(chatId, "group", ["+155****9041"]);
    await publisher.sweepRoster(source);

    // Simulated restart with chat.db unavailable: the fresh publisher holds
    // no in-memory scope state, only the persisted inventory.
    const restarted = new IMessageMembershipPublisher({
      runtime,
      connectorAccountId,
      accountKey: "default",
      service: membership,
    });
    await restarted.degradePersistedScopes([chatId]);

    const scope = await scopeFor(chatId);
    const health = await membership.getScopeHealth(scope);
    expect(health?.health).toBe("unavailable");
    const decision = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+155****9041"),
    );
    expect(decision.decision).toBe("denied");
  });
});

/**
 * RP R2 follow-up coverage: canonical handle-index wiring (variant target
 * spellings resolve through the shared normalizer), ambiguous-index
 * collision denial, startup reconciliation of removed scopes, and
 * committed-only index feeding on fenced commit failure.
 */
describe("iMessage membership R2 fixes (canonical index + reconciliation)", () => {
  it("variant target spellings resolve through the shared canonical normalizer", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;-;+155****9051";
    source.setChat(chatId, "direct", ["+155****9051"]);

    const canonical = (raw: string) =>
      raw.replace(/^(\+\d{3})\*{4}(\d{4})$/, "$1$2");
    const gated = new IMessageMembershipPublisher({
      runtime,
      connectorAccountId,
      accountKey: "default",
      service: membership,
      normalizeTarget: canonical,
    });
    const published = await gated.sweepRoster(source);
    expect(published).toBe(1);

    // The roster spelling resolves...
    expect(await gated.authorizeOutbound("+155****9051")).toBe(true);
    // ...and so does the variant spelling the connector would format to.
    expect(await gated.authorizeOutbound("+1559051")).toBe(true);
    // Ungoverned variant stays ungoverned.
    expect(await gated.authorizeOutbound("+155****9998")).toBeNull();
  });

  it("an ambiguous canonical collision denies instead of resolving the wrong chat", async () => {
    const source = new SyntheticRosterSource();
    source.setChat("Imessage;-;+155****9061", "direct", ["+155****9061"]);
    source.setChat("Imessage;-;+155****9062", "direct", ["+155****9062"]);
    const canonical = () => "+155same";
    const gated = new IMessageMembershipPublisher({
      runtime,
      connectorAccountId,
      accountKey: "default",
      service: membership,
      normalizeTarget: canonical,
    });
    await gated.sweepRoster(source);

    // Both distinct roster spellings canonicalize to one key: the index is
    // ambiguous, so the gate must DENY (fail-closed), not guess a scope.
    expect(await gated.authorizeOutbound("+155****9061")).toBe(false);
    expect(await gated.authorizeOutbound("+155****9062")).toBe(false);
  });

  it("reconcileRemovedScopes degrades persisted chats the fresh roster no longer lists", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;+;chat-reconcile-1;+155****9071";
    source.setChat(chatId, "group", ["+155****9071"]);
    await publisher.sweepRoster(source);

    const scope = await scopeFor(chatId);
    expect(
      (
        await membership.authorize(
          scope,
          imessageMembershipPrincipalId("default", "+155****9071"),
        )
      ).decision,
    ).toBe("allowed");

    // The chat vanished from the fresh roster: the persisted inventory
    // entry must degrade, not silently un-govern.
    const next = new SyntheticRosterSource();
    await publisher.reconcileRemovedScopes([chatId], next);

    const health = await membership.getScopeHealth(scope);
    expect(health?.health).toBe("unavailable");
    expect(
      (
        await membership.authorize(
          scope,
          imessageMembershipPrincipalId("default", "+155****9071"),
        )
      ).decision,
    ).toBe("denied");
  });

  it("an emptied roster degrades every previously governed scope (empty-sweep ratchet)", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;+;chat-ratchet-1;+155****9091";
    source.setChat(chatId, "group", ["+155****9091"]);
    let persisted: readonly string[] = [];
    const tracked = new IMessageMembershipPublisher({
      runtime,
      connectorAccountId,
      accountKey: "default",
      service: membership,
      onRosterCommitted: async (chatIds) => {
        persisted = [...chatIds];
      },
    });
    await tracked.sweepRoster(source);
    expect(persisted).toContain(chatId);

    // The roster empties (chat deleted): the sweep commits nothing, but the
    // ratchet must still degrade the previously governed scope and persist
    // the empty inventory.
    const empty = new SyntheticRosterSource();
    await tracked.sweepRoster(empty);
    expect(persisted).toEqual([]);

    const scope = await scopeFor(chatId);
    const health = await membership.getScopeHealth(scope);
    expect(health?.health).toBe("unavailable");
    expect(
      (
        await membership.authorize(
          scope,
          imessageMembershipPrincipalId("default", "+155****9091"),
        )
      ).decision,
    ).toBe("denied");
  });

  it("authorizeOutboundInChat fails closed for governed chats with unresolvable targets", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;-;+155****9095";
    source.setChat(chatId, "direct", ["+155****9095"]);
    await publisher.sweepRoster(source);

    const scope = await scopeFor(chatId);
    expect(
      (
        await membership.authorize(
          scope,
          imessageMembershipPrincipalId("default", "+155****9095"),
        )
      ).decision,
    ).toBe("allowed");

    // A variant spelling the index cannot resolve, inside a durably
    // governed chat: DENY, not legacy-ungated null.
    expect(await publisher.authorizeOutboundInChat("+1559095", chatId)).toBe(
      false,
    );

    // An ungoverned chat with no durable scope stays null (legacy).
    expect(
      await publisher.authorizeOutboundInChat(
        "+155****7777",
        "Imessage;-;+155****7777",
      ),
    ).toBeNull();
  });

  it("a fenced commit failure keeps the chat out of the committed index and inventory", async () => {
    const source = new SyntheticRosterSource();
    const chatId = "Imessage;-;+155****9081";
    source.setChat(chatId, "direct", ["+155****9081"]);

    // Delegate every authority call to the REAL service so registration and
    // health reads succeed; intercept only applyCompleteSnapshot to throw a
    // fence error. Both fenced retries must exhaust and the snapshot must
    // fail without fabricating success.
    let snapshotAttempts = 0;
    const broken = new Proxy(membership, {
      get(target, prop, receiver) {
        if (prop === "applyCompleteSnapshot") {
          return async () => {
            snapshotAttempts += 1;
            const err = new Error("fence") as Error & { code?: string };
            err.code = "MEMBERSHIP_GENERATION_FENCE";
            throw err;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    let persistedInventory: readonly string[] = [];
    const fenced = new IMessageMembershipPublisher({
      runtime,
      connectorAccountId,
      accountKey: "default",
      service: broken,
      onRosterCommitted: async (chatIds) => {
        persistedInventory = [...chatIds];
      },
    });
    // The per-chat sweep catch reports the failure and skips the chat, so
    // the sweep resolves (0 published) instead of throwing the loop away.
    const published = await fenced.sweepRoster(source);
    expect(published).toBe(0);

    // Both fenced attempts actually ran (the exhaustion path was reached,
    // not a pre-snapshot TypeError).
    expect(snapshotAttempts).toBeGreaterThanOrEqual(2);

    // The outbound index must NOT contain the uncommitted chat's handle.
    expect(await fenced.authorizeOutbound("+155****9081")).toBeNull();

    // The persisted inventory must not record the uncommitted chat.
    expect(persistedInventory).not.toContain(chatId);
  });
});

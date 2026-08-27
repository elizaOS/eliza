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
import { AgentRuntime, type MembershipScope, MembershipService, type UUID } from "@elizaos/core";
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
  private chats = new Map<string, { chatType: "direct" | "group"; handles: string[] }>();
  private counter = 0;
  failure: Error | null = null;

  setChat(chatId: string, chatType: "direct" | "group", handles: string[]): void {
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
      participants: chat.handles.map((handle) => ({ handle, service: "iMessage" })),
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
  restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "imessage-membership-24370-"));
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
  const sqlPlugin = sqlModule.default ?? (sqlModule.plugin as { plugins?: unknown[] });
  if (sqlPlugin) {
    await runtime.registerPlugin(sqlPlugin as Parameters<AgentRuntime["registerPlugin"]>[0]);
  }
  await runtime.initialize();
  const services = runtime.getServicesByType<MembershipService>(MembershipService.serviceType);
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
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
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
        imessageMembershipPrincipalId("default", handle)
      );
      expect(decision.decision).toBe("allowed");
    }

    // A handle not in the roster must be denied: the roster is the truth.
    const outsider = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550009999")
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
      imessageMembershipPrincipalId("default", "+15550005555")
    );
    expect(removed.decision).toBe("denied");
    const kept = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550004444")
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
      imessageMembershipPrincipalId("default", "+15550006666")
    );
    expect(decision.decision).toBe("denied");

    // Recovery: reads succeed again and a complete snapshot restores admission.
    source.failure = null;
    const restored = await publisher.sweepRoster(source);
    expect(restored).toBeGreaterThanOrEqual(1);
    const after = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550006666")
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
      imessageMembershipPrincipalId("default", "+15550007777")
    );
    expect(before?.state).toBe("active");

    // Within the renewal window the same sender is not re-proven: the sweep
    // just stamped this principal, so the in-process gate dedupes the
    // inbound-message renewal (the authoritative refresh path is the sweep).
    const tooSoon = await publisher.renewSender({ chatId, handle: "+15550007777" });
    expect(tooSoon).toBe(false);

    // A renewed principal is still admitted: the committed snapshot evidence
    // carries the authorization, not the in-memory renewal map.
    const decision = await membership.authorize(
      scope,
      imessageMembershipPrincipalId("default", "+15550007777")
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
      imessageMembershipPrincipalId("default", "+15550008888")
    );
    expect(decision.decision).toBe("allowed");
  });
});

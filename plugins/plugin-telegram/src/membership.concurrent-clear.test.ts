/**
 * Regression for the concurrent removal/re-add race (PR #28715 review):
 * Telegraf dispatches one polling batch concurrently
 * (`Promise.all(updates.map(handleUpdate))`), so a re-add clear can run
 * while an earlier removal is still awaiting its durable health write.
 * Without serialization the clear observes no tombstone and returns; the
 * removal resumes and installs the tombstone AFTER the clear, permanently
 * denying a chat the bot is present in again. Deterministic unit harness:
 * the REAL TelegramMembershipAuthority runs over an instrumented service
 * double that can pause the health write; the observable is whether a
 * post-re-add evidence write is accepted (recordEvent resolves) or
 * tombstone-rejected.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { TelegramMembershipAuthority } from "./membership";

function makeAuthority(options?: {
  pauseFirstHealthWrite?: () => Promise<void>;
}) {
  let healthWriteCalls = 0;
  const service = {
    getScopeHealth: vi.fn(async () => null),
    setScopeHealth: vi.fn(async () => {
      healthWriteCalls += 1;
      if (healthWriteCalls === 1) {
        await options?.pauseFirstHealthWrite?.();
      }
      return { operation: "health" };
    }),
    registerPublisher: vi.fn(async () => ({ operation: "publisher" })),
    applyMembership: vi.fn(async () => ({ applied: true })),
    getMembership: vi.fn(async () => null),
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000a1",
    reportError: vi.fn(),
    getCache: vi.fn(async () => undefined),
    setCache: vi.fn(async () => true),
    deleteCache: vi.fn(async () => true),
    createEntity: vi.fn(async () => true),
    createWorld: vi.fn(async () => true),
    createRoom: vi.fn(async () => true),
  } as unknown as IAgentRuntime;
  const authority = new TelegramMembershipAuthority({
    runtime,
    connectorAccountId: "00000000-0000-0000-0000-0000000000c1" as never,
    service: service as never,
  });
  return { authority, service };
}

const SCOPE = { chatId: "-100999", chatRoomKey: "-100999" };
const PRINCIPAL = "00000000-0000-0000-0000-000000000001" as never;

async function recordJoin(authority: TelegramMembershipAuthority) {
  return authority.recordEvent({
    ...SCOPE,
    canonicalPrincipalId: PRINCIPAL,
    state: "active",
    reason: "joined",
    messageId: 1,
    telegramUserId: "42",
    runtime: { worldId: null, roomId: null, entityId: PRINCIPAL },
    observedAt: new Date().toISOString(),
  });
}

describe("concurrent removal/re-add serialization", () => {
  it("re-add clear waits for an in-flight removal: fresh post-re-add evidence is not tombstoned", async () => {
    // Pause the removal's durable health write until the re-add clear has
    // been issued — the exact interleaving Telegraf's concurrent batch
    // dispatch makes possible.
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const { authority, service } = makeAuthority({
      pauseFirstHealthWrite: () => removalGate,
    });

    // Seed the scope so the removal's publisher bookkeeping resolves.
    await recordJoin(authority);

    const removal = authority.markScopeUnavailable({
      ...SCOPE,
      reason: "bot_removed",
    });
    // Let the removal enter its serialized chain and reach the paused write.
    await new Promise((r) => setTimeout(r, 5));
    // Re-add lands while the removal is still awaiting the health write.
    // With the clear serialized behind the removal chain, it runs AFTER the
    // tombstone is installed — and clears it. On the unfixed code the clear
    // ran immediately (no tombstone yet), returned, and the removal then
    // installed a tombstone that survives forever.
    const clear = authority.clearScopeRemoval(SCOPE);
    await new Promise((r) => setTimeout(r, 5));
    releaseRemoval();
    await Promise.all([removal, clear]);

    // Fresh post-re-add evidence must be ACCEPTED: the evidence write
    // reaches the membership service. On the unfixed code the clear ran
    // before the tombstone existed and returned; the removal then installed
    // a tombstone that survives forever, and this applyMembership call is
    // SKIPPED (tombstone rejection).
    const evidenceCalls = service.applyMembership.mock.calls.length;
    await recordJoin(authority);
    expect(service.applyMembership.mock.calls.length).toBe(evidenceCalls + 1);
  });
});

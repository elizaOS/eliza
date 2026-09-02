/**
 * Regression test for the re-add-then-restart durability gap in the
 * Telegram membership authority (PR #28715 review round, mashingaan
 * 2026-09-02): clearScopeRemoval persists a durable re-add watermark in the
 * runtime cache, so a process restart between the bot re-add and the next
 * fresh evidence write no longer re-hydrates the bot-removal tombstone from
 * the stale persisted "unavailable" scope health (the bot is already
 * present, so no second my_chat_member re-add transition would ever arrive
 * to clear it). Pre-re-add backlogged evidence stays denied through the
 * re-hydrated in-memory watermark.
 *
 * Real-PGlite harness identical to __tests__/membership-authority.real.test.ts:
 * real AgentRuntime + real SqlMembershipService; restart simulated by
 * stopping the first runtime and booting a second over the same PGlite dir.
 */
import type { UUID } from "@elizaos/core";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
} from "@elizaos/core/testing";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

const CHAT_ID = -3101;
const MEMBER_TG_ID = 655_001;

async function bootAuthority(pgliteDir: string) {
  const harness = await createTestRuntimeWithModelProvider({ pgliteDir });
  cleanups.push(harness.cleanup);
  const membershipService = harness.runtime.getService(
    "membership",
  ) as import("@elizaos/core").MembershipService;
  const { getConnectorAccountManager } = await import("@elizaos/core");
  const manager = await getConnectorAccountManager(harness.runtime);
  const stored = await manager.upsertAccount("telegram", {
    id: "telegram-910001",
    provider: "telegram",
    label: "Telegram bot 910001",
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    externalId: "910001",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!stored.id) throw new Error("connector account upsert returned no id");
  const { TelegramMembershipAuthority } = await import(
    "@elizaos/plugin-telegram"
  );
  const authority = new TelegramMembershipAuthority({
    runtime: harness.runtime,
    connectorAccountId: stored.id as UUID,
    service: membershipService,
  });
  return { harness, authority };
}

async function ensurePrincipal(
  harness: ModelProviderTestRuntime,
  entityId: UUID,
): Promise<void> {
  const created = await harness.runtime.createEntity({
    id: entityId,
    agentId: harness.runtime.agentId,
    names: ["Re-add Restart Probe User"],
    metadata: {},
  });
  if (!created) throw new Error("test principal entity creation failed");
}

describe("bot re-add durability across restart", () => {
  it("fresh post-re-add evidence recovers admission after a restart, while pre-re-add evidence stays denied", async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp("/tmp/tg-membership-readd-restart-");
    const { resolveTelegramRuntimeEntityId } = await import(
      "@elizaos/plugin-telegram"
    );

    // Process 1: member joins, bot is removed (persists unavailable),
    // then the bot is re-added (clearScopeRemoval — in-memory only).
    const first = await bootAuthority(dir);
    const entityId = (await resolveTelegramRuntimeEntityId(
      first.harness.runtime,
      "default",
      String(MEMBER_TG_ID),
    )) as UUID;
    await ensurePrincipal(first.harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };

    await first.authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 1,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date().toISOString(),
    });
    await first.authority.markScopeUnavailable({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      reason: "bot_removed",
    });
    await first.authority.clearScopeRemoval({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
    });

    // Restart: stop the first runtime, boot a second over the same DB.
    const cleanupIndex = cleanups.indexOf(first.harness.cleanup);
    if (cleanupIndex >= 0) cleanups.splice(cleanupIndex, 1);
    // error-policy:J6 Best-effort teardown: a stop() rejection during test
    // cleanup must not mask the assertions below.
    await first.harness.runtime.stop().catch(() => {});
    const second = await bootAuthority(dir);

    // PRE-re-add evidence (backlogged, stamped before the re-add moment)
    // must stay denied.
    await second.authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 2,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const backloggedDecision = await second.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      backloggedDecision.decision,
      "backlogged pre-re-add evidence must not authorize after restart",
    ).toBe("denied");

    // FRESH evidence (stamped after the re-add) must recover admission
    // even after the restart — this is the gap: today the re-hydrated
    // tombstone rejects it indefinitely.
    await second.authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 3,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date().toISOString(),
    });
    const freshDecision = await second.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      freshDecision.decision,
      "fresh post-re-add evidence must recover admission after a restart",
    ).toBe("allowed");

    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
  }, 120_000);
});

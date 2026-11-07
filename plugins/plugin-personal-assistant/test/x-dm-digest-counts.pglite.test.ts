/**
 * X DM digest totals against the real PGlite LifeOps cache. The digest's
 * unread/read/replied counts describe curation state over the whole cache,
 * while the caller's `limit` bounds only the `recent` preview list; proving
 * that split requires the real `life_x_dms` rows, so this suite boots the real
 * plugin runtime and seeds the cache through the real repository. The X
 * connector is intentionally absent so the digest takes its cached path.
 */
import type { LifeOpsConnectorGrant, LifeOpsXDm } from "@elizaos/contracts";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let service: LifeOpsService;

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedDm(args: {
  index: number;
  minutesAgo: number;
  isInbound: boolean;
  readAt?: string | null;
  repliedAt?: string | null;
  conversationId?: string;
}): LifeOpsXDm {
  const now = new Date().toISOString();
  return {
    id: `${runtime.agentId}:x:digest-dm-${args.index}`,
    agentId: runtime.agentId,
    externalDmId: `digest-dm-${args.index}`,
    conversationId: args.conversationId ?? "conv-digest",
    senderHandle: `sender_${args.index}`,
    senderId: `sender-id-${args.index}`,
    isInbound: args.isInbound,
    text: `digest message ${args.index}`,
    receivedAt: minutesAgoIso(args.minutesAgo),
    readAt: args.readAt ?? null,
    repliedAt: args.repliedAt ?? null,
    metadata: { source: "pglite-digest-fixture" },
    syncedAt: now,
    updatedAt: now,
  };
}

/** Newest-to-oldest: 1 outbound, 1 inbound read, 6 inbound unread (1 replied). */
function seedCache(): LifeOpsXDm[] {
  return [
    seedDm({ index: 1, minutesAgo: 1, isInbound: false }),
    seedDm({
      index: 2,
      minutesAgo: 2,
      isInbound: true,
      readAt: minutesAgoIso(1),
    }),
    seedDm({ index: 3, minutesAgo: 3, isInbound: true }),
    seedDm({ index: 4, minutesAgo: 10, isInbound: true }),
    seedDm({ index: 5, minutesAgo: 20, isInbound: true }),
    seedDm({ index: 6, minutesAgo: 40, isInbound: true }),
    seedDm({ index: 7, minutesAgo: 60, isInbound: true }),
    seedDm({
      index: 8,
      minutesAgo: 90,
      isInbound: true,
      repliedAt: minutesAgoIso(30),
    }),
    seedDm({
      index: 9,
      minutesAgo: 45,
      isInbound: true,
      conversationId: "conv-other",
    }),
  ];
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  service = new LifeOpsService(runtime);

  const now = new Date().toISOString();
  const grant: LifeOpsConnectorGrant = {
    id: "connector-account:x-digest-owner",
    agentId: runtime.agentId,
    provider: "x",
    connectorAccountId: "x-digest-owner",
    side: "owner",
    identity: { id: "12345", username: "digest_owner" },
    identityEmail: null,
    grantedScopes: [],
    capabilities: ["x.read", "x.dm.read"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await service.repository.upsertConnectorGrant(grant);
  for (const dm of seedCache()) {
    await service.repository.upsertXDm(dm);
  }
});

afterAll(async () => {
  await runtimeResult?.cleanup();
});

describe("LifeOps X DM digest totals over the real cache", () => {
  it("counts unread/read/replied across the whole cache while limiting only the recent preview", async () => {
    const digest = await service.getXDmDigest({ limit: 3 });

    // Seven inbound unread DMs exist (dm-3..dm-9); dm-1 is the account's own
    // outbound reply. The newest 3 rows hold only one of those unread DMs, so
    // a window-bounded count would under-report unreadCount as 1.
    expect(digest.unreadCount).toBe(7);
    expect(digest.readCount).toBe(1);
    expect(digest.repliedCount).toBe(1);
    expect(digest.recent).toHaveLength(3);
    expect(digest.recent[0]?.id).toBe(`${runtime.agentId}:x:digest-dm-1`);
    expect(digest.recent[2]?.id).toBe(`${runtime.agentId}:x:digest-dm-3`);
  });

  it("returns the same totals without a preview limit", async () => {
    const digest = await service.getXDmDigest();

    expect(digest.unreadCount).toBe(7);
    expect(digest.readCount).toBe(1);
    expect(digest.repliedCount).toBe(1);
    expect(digest.recent).toHaveLength(9);
  });

  it("scopes both totals and preview to the requested conversation", async () => {
    const digest = await service.getXDmDigest({
      conversationId: "conv-other",
      limit: 5,
    });

    expect(digest.unreadCount).toBe(1);
    expect(digest.recent).toHaveLength(1);
    expect(digest.recent[0]?.id).toBe(`${runtime.agentId}:x:digest-dm-9`);
  });
});

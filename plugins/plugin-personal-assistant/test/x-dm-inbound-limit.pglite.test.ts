/**
 * X DM inbound reads against the real PGlite LifeOps cache. The cache stores
 * the account's own outbound replies beside inbound DMs, so a `listXDms` read
 * that applied `LIMIT` before the inbound direction filter would return fewer
 * (or zero) inbound rows whenever newer owner replies fill the window (#33926)
 * — the inbox X DM list and X verify both read through that path. This suite
 * pins the repository SQL and the `readXInboundDms` consumer against real
 * `life_x_dms` rows; the service-level delegation tests stub
 * `repository.listXDms`, so only these assertions execute the real query.
 * The X connector is intentionally absent so both reads take their cached
 * path.
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
}): LifeOpsXDm {
  const now = new Date().toISOString();
  return {
    id: `${runtime.agentId}:x:inbound-limit-dm-${args.index}`,
    agentId: runtime.agentId,
    externalDmId: `inbound-limit-dm-${args.index}`,
    conversationId: "conv-inbound-limit",
    senderHandle: args.isInbound ? "friend" : "owner",
    senderId: args.isInbound ? "friend-id" : "owner-id",
    isInbound: args.isInbound,
    text: args.isInbound
      ? `question ${args.index}`
      : `owner reply ${args.index}`,
    receivedAt: minutesAgoIso(args.minutesAgo),
    readAt: null,
    repliedAt: null,
    metadata: { source: "pglite-inbound-fixture" },
    syncedAt: now,
    updatedAt: now,
  };
}

/**
 * Newest-to-oldest: three owner outbound replies above four inbound DMs, so
 * any limit-first window of three or fewer rows contains no inbound DM at all.
 */
function seedCache(): LifeOpsXDm[] {
  return [
    seedDm({ index: 1, minutesAgo: 1, isInbound: false }),
    seedDm({ index: 2, minutesAgo: 2, isInbound: false }),
    seedDm({ index: 3, minutesAgo: 3, isInbound: false }),
    seedDm({ index: 4, minutesAgo: 4, isInbound: true }),
    seedDm({ index: 5, minutesAgo: 5, isInbound: true }),
    seedDm({ index: 6, minutesAgo: 6, isInbound: true }),
    seedDm({ index: 7, minutesAgo: 7, isInbound: true }),
  ];
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  service = new LifeOpsService(runtime);

  const now = new Date().toISOString();
  const grant: LifeOpsConnectorGrant = {
    id: "connector-account:x-inbound-limit-owner",
    agentId: runtime.agentId,
    provider: "x",
    connectorAccountId: "x-inbound-limit-owner",
    side: "owner",
    identity: { id: "67890", username: "inbound_limit_owner" },
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

describe("X DM inbound reads over the real PGlite cache", () => {
  it("filters direction before the limit in the repository query", async () => {
    const rows = await service.repository.listXDms(runtime.agentId, {
      inbound: true,
      limit: 3,
    });

    // The three newest rows overall are the owner's outbound replies; the
    // three newest inbound DMs sit below them. Direction must be filtered
    // before LIMIT, or this window returns only outbound rows.
    expect(rows.map((dm) => dm.externalDmId)).toEqual([
      "inbound-limit-dm-4",
      "inbound-limit-dm-5",
      "inbound-limit-dm-6",
    ]);
    expect(rows.every((dm) => dm.isInbound)).toBe(true);
  });

  it("returns inbound DMs hidden behind newer owner replies from readXInboundDms", async () => {
    const inbound = await service.readXInboundDms({ limit: 2 });

    expect(inbound.map((dm) => dm.text)).toEqual(["question 4", "question 5"]);
    expect(inbound.every((dm) => dm.isInbound)).toBe(true);
  });

  it("returns every inbound DM and no outbound reply without a limit", async () => {
    const inbound = await service.readXInboundDms();

    expect(inbound.map((dm) => dm.externalDmId)).toEqual([
      "inbound-limit-dm-4",
      "inbound-limit-dm-5",
      "inbound-limit-dm-6",
      "inbound-limit-dm-7",
    ]);
  });

  it("keeps the unfiltered read's newest-first window unchanged", async () => {
    const rows = await service.repository.listXDms(runtime.agentId, {
      limit: 2,
    });

    // Direction-less reads (for example the digest `recent` preview) still
    // return the true newest rows of the mixed-direction cache.
    expect(rows.map((dm) => dm.externalDmId)).toEqual([
      "inbound-limit-dm-1",
      "inbound-limit-dm-2",
    ]);
    expect(rows.every((dm) => !dm.isInbound)).toBe(true);
  });
});

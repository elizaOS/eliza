/**
 * Proves X DM curation targets the exact cache rows the caller names on the
 * real PGlite schema, through LifeOpsService and the stored connector grant.
 * Curation is cache-local, so no X provider or credential boundary is touched.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { RealTestRuntimeResult } from "../../test/helpers/runtime.js";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "./repository.js";
import { LifeOpsService } from "./service.js";

const SYNCED_AT = "2026-10-06T08:00:00.000Z";
const TOTAL_DMS = 40;
const NEWEST_WINDOW = 25;

function receivedAt(index: number): string {
  return new Date(
    Date.parse(SYNCED_AT) - (TOTAL_DMS - index) * 60_000,
  ).toISOString();
}

function rowId(index: number): string {
  return `x-dm-row-${index}`;
}

describe("LifeOpsService X DM curation", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;
  let runtime: RealTestRuntimeResult["runtime"];
  let repository: LifeOpsRepository;
  let service: LifeOpsService;

  async function seedUnreadDms(): Promise<void> {
    for (let index = 0; index < TOTAL_DMS; index += 1) {
      await repository.upsertXDm({
        id: rowId(index),
        agentId: runtime.agentId,
        externalDmId: `dm-${index}`,
        conversationId: "x-conversation-curation",
        senderHandle: index % 2 === 0 ? "sender" : "owner",
        senderId: index % 2 === 0 ? "sender-id" : "owner-id",
        isInbound: index % 2 === 0,
        text: `curation fixture ${index}`,
        receivedAt: receivedAt(index),
        readAt: null,
        repliedAt: null,
        metadata: { source: "x" },
        syncedAt: SYNCED_AT,
        updatedAt: SYNCED_AT,
      });
    }
  }

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  async function setup(): Promise<void> {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    repository = new LifeOpsRepository(runtime);
    await repository.upsertConnectorGrant(
      createLifeOpsConnectorGrant({
        agentId: runtime.agentId,
        provider: "x",
        connectorAccountId: "x-owner-account",
        identity: { id: "123", username: "owner" },
        grantedScopes: [],
        capabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
        tokenRef: null,
        mode: "local",
        metadata: {},
        lastRefreshAt: SYNCED_AT,
      }),
    );
    await seedUnreadDms();
    service = new LifeOpsService(runtime);
  }

  it("curates only the newest window when no message ids are requested", async () => {
    await setup();

    const result = await service.curateXDms({ markRead: true });

    expect(result.curated).toBe(NEWEST_WINDOW);
    const rows = await repository.listXDms(runtime.agentId, {
      conversationId: "x-conversation-curation",
    });
    const unread = rows.filter((dm) => dm.readAt === null);
    expect(unread).toHaveLength(TOTAL_DMS - NEWEST_WINDOW);
    expect(unread.map((dm) => dm.id).sort()).toEqual(
      Array.from({ length: TOTAL_DMS - NEWEST_WINDOW }, (_, i) =>
        rowId(i),
      ).sort(),
    );
  });

  it("curates requested ids older than the newest window instead of silently skipping them", async () => {
    await setup();

    // Rows 1 and 2 are the two oldest cache entries; the pre-fix newest-rows
    // window could never contain them, so curation reported success while
    // leaving both rows unchanged.
    const result = await service.curateXDms({
      messageIds: [rowId(1), rowId(2)],
      markRead: true,
      markReplied: true,
    });

    expect(result.curated).toBe(2);
    const targeted = await repository.listXDms(runtime.agentId, {
      ids: [rowId(1), rowId(2)],
    });
    expect(targeted).toHaveLength(2);
    for (const dm of targeted) {
      expect(dm.readAt).not.toBeNull();
      expect(dm.repliedAt).not.toBeNull();
    }
    const control = await repository.listXDms(runtime.agentId, {
      ids: [rowId(0), rowId(39)],
    });
    expect(control).toHaveLength(2);
    for (const dm of control) {
      expect(dm.readAt).toBeNull();
      expect(dm.repliedAt).toBeNull();
    }
  });
});

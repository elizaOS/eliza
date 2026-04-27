import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLifeOpsActivitySignal,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000bbbb";

describe("LifeOps activity signal schema repair", () => {
  let pgClient: PGlite | null = null;

  afterEach(async () => {
    await pgClient?.close();
    pgClient = null;
  });

  it("repairs legacy activity signal tables before idle samples are persisted", async () => {
    pgClient = new PGlite();
    const db = drizzle(pgClient);
    await db.execute(
      sql.raw(`
        CREATE TABLE life_activity_signals (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          source TEXT NOT NULL,
          state TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        )
      `),
    );
    const runPluginMigrations = vi.fn(async () => undefined);
    const runtime = {
      agentId: AGENT_ID,
      adapter: {
        db,
        isReady: async () => true,
        runPluginMigrations,
      },
    } as unknown as IAgentRuntime;

    await LifeOpsRepository.bootstrapSchema(runtime);

    const repository = new LifeOpsRepository(runtime);
    await repository.createActivitySignal(
      createLifeOpsActivitySignal({
        agentId: AGENT_ID,
        source: "desktop_interaction",
        platform: "macos_activity_collector",
        state: "idle",
        observedAt: "2026-04-27T07:53:50.404Z",
        idleState: "idle",
        idleTimeSeconds: 142,
        onBattery: null,
        health: null,
        metadata: {
          source: "activity_collector_hid_idle",
        },
      }),
    );

    const rows = await repository.listActivitySignals(AGENT_ID, {
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: "macos_activity_collector",
      idleState: "idle",
      idleTimeSeconds: 142,
    });
  });
});

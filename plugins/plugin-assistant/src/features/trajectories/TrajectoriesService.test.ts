/**
 * Storage-initialization coverage for `TrajectoriesService`: capture stays off
 * when the runtime adapter exposes no SQL executor, and gated-off storage runs
 * no DDL at boot while concurrent first reads share one schema migration on a
 * real PGlite database.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTrajectoriesTable } from "./store/trajectory-internals.ts";
import { TrajectoriesService } from "./TrajectoriesService.ts";

function createRuntimeWithoutSql(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    adapter: { db: {} },
    getService: () => null,
    getServicesByType: () => [],
    reportError: () => {},
  } as unknown as IAgentRuntime;
}

describe("TrajectoriesService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables SQL-backed capture when the runtime adapter has no SQL executor", async () => {
    vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "1");
    const service = await TrajectoriesService.start(createRuntimeWithoutSql());

    expect((service as TrajectoriesService).isEnabled()).toBe(false);

    await service.stop();
  });

  it("defers gated-off storage and shares concurrent first reads", async () => {
    vi.stubEnv("ELIZA_DISABLE_TRAJECTORY_LOGGING", "1");
    const client = new PGlite();
    const db = drizzle(client);
    const statements: string[] = [];
    let pauseProbe = false;
    let probeReaders = 0;
    let releaseProbe = () => {};
    const probeBarrier = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const sqlDb = {
      execute: async (query: ReturnType<typeof sql.raw>) => {
        const chunks = (
          query as unknown as {
            queryChunks: Array<{ value?: unknown }>;
          }
        ).queryChunks;
        const text = chunks
          .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
          .join("");
        statements.push(text);
        if (
          pauseProbe &&
          text.includes("SELECT id FROM trajectories LIMIT 1") &&
          probeReaders < 2
        ) {
          probeReaders += 1;
          if (probeReaders === 2) releaseProbe();
          else setTimeout(releaseProbe, 200);
          await probeBarrier;
        }
        return db.execute(query);
      },
      transaction: <T>(
        work: (executor: {
          execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        db.transaction((tx) => work({ execute: (query) => tx.execute(query) })),
    };
    const runtime = {
      ...createRuntimeWithoutSql(),
      runtimeInstanceId: "runtime-instance-1",
      adapter: { db: sqlDb },
    } as unknown as IAgentRuntime;
    try {
      const service = (await TrajectoriesService.start(
        runtime,
      )) as TrajectoriesService;
      expect(service.isEnabled()).toBe(false);
      expect(statements).toEqual([]);

      // An existing database needs a column migration on its first read.
      // Schema readiness is remembered per runtime, so a second runtime over
      // the same database creates the tables that this service then migrates.
      await ensureTrajectoriesTable({ ...runtime } as IAgentRuntime);
      await db.execute(
        sql.raw("ALTER TABLE trajectories DROP COLUMN scenario_id"),
      );
      statements.length = 0;
      pauseProbe = true;
      await Promise.all([service.listTrajectories(), service.getStats()]);
      expect(probeReaders).toBe(1);
      expect(
        statements.filter((text) =>
          text.includes("ALTER TABLE trajectories ADD COLUMN scenario_id"),
        ),
      ).toHaveLength(1);

      // An operator turns capture on later: the tables exist before the first row.
      service.setEnabled(true);
      const trajectoryId = await service.startTrajectory(runtime.agentId);
      await service.flushWriteQueue(trajectoryId);
      const rows = await db.execute(
        sql.raw(`SELECT id FROM trajectories WHERE id = '${trajectoryId}'`),
      );
      expect(rows.rows).toHaveLength(1);

      await service.stop();
    } finally {
      await client.close();
    }
  });
});

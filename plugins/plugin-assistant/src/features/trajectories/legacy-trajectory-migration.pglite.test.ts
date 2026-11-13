/** Preserves pre-row-store history through the canonical service and real SQL. */
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { ensureTrajectoriesTable } from "./store/trajectory-internals.ts";
import { TrajectoriesService } from "./TrajectoriesService.ts";

for (const failMigration of [false, true]) {
  it(`preserves complete legacy steps ${failMigration ? "through a failed migration and retry" : "when the canonical row store first opens"}`, async () => {
    const client = new PGlite();
    const db = drizzle(client);
    const agentId = randomUUID();
    let refuseSecondStep = false;
    let attemptedSteps = 0;
    const runtime = (injectFailure: boolean) =>
      ({
        agentId,
        runtimeInstanceId: randomUUID(),
        adapter: {
          db: {
            execute: (query: ReturnType<typeof sql.raw>) => db.execute(query),
            transaction: <T>(
              work: (tx: {
                execute: (
                  query: ReturnType<typeof sql.raw>,
                ) => Promise<unknown>;
              }) => Promise<T>,
            ) =>
              db.transaction((tx) =>
                work({
                  execute: async (query) => {
                    const text = query.queryChunks
                      .flatMap((chunk) =>
                        typeof chunk === "object" &&
                        chunk !== null &&
                        "value" in chunk &&
                        Array.isArray(chunk.value)
                          ? chunk.value
                          : [],
                      )
                      .join("");
                    if (
                      injectFailure &&
                      refuseSecondStep &&
                      text.includes("INSERT INTO trajectory_steps") &&
                      ++attemptedSteps === 2
                    ) {
                      refuseSecondStep = false;
                      throw new Error(
                        "controlled second migration step failure",
                      );
                    }
                    return tx.execute(query);
                  },
                }),
              ),
          },
        },
        getService: () => null,
        getServicesByType: () => [],
        getSetting: () => undefined,
        reportError: () => {},
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      }) as unknown as IAgentRuntime;
    const sourceRuntime = runtime(false);
    const source = new TrajectoriesService(sourceRuntime);
    source.setEnabled(true);
    const readerRuntime = runtime(true);
    const reader = new TrajectoriesService(readerRuntime);
    try {
      await ensureTrajectoriesTable(sourceRuntime);
      const trajectoryId = await source.startTrajectory(agentId);
      const originalPrompt = `  Complete original history ${"😀α ".repeat(20_000)} FINAL-SOURCE\n`;
      for (const label of ["first", "second"]) {
        const stepId = source.startStep(trajectoryId, { kind: "llm" });
        source.logLlmCall({
          stepId,
          model: "legacy-fixture",
          purpose: "action",
          actionType: "runtime.useModel",
          systemPrompt: "Retain exact history.",
          userPrompt: `${label}: ${originalPrompt}`,
          response: `${label} result`,
          promptTokens: 11,
          completionTokens: 2,
        });
      }
      await source.flushWriteQueue(trajectoryId);
      await source.endTrajectory(trajectoryId, "completed");
      const before = await source.getTrajectoryDetail(trajectoryId);
      expect(before?.steps).toHaveLength(2);
      const beforeExport = JSON.parse(
        String(
          (
            await source.exportTrajectories({
              format: "json",
              includePrompts: true,
              trajectoryIds: [trajectoryId],
            })
          ).data,
        ),
      );
      const rows = await db.execute(
        sql.raw(
          `SELECT payload FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}' ORDER BY ordinal`,
        ),
      );
      const legacy = rows.rows.map((row) =>
        typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      );
      await db.execute(
        sql.raw(
          "ALTER TABLE trajectories ADD COLUMN IF NOT EXISTS steps_json TEXT NOT NULL DEFAULT '[]'",
        ),
      );
      await db.execute(
        sql.raw(
          `UPDATE trajectories SET steps_json = '${JSON.stringify(legacy).replaceAll("'", "''")}' WHERE id = '${trajectoryId}'`,
        ),
      );
      await db.execute(
        sql.raw(
          `DELETE FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}'`,
        ),
      );
      refuseSecondStep = failMigration;
      const restored = await reader.getTrajectoryDetail(trajectoryId);
      expect(restored).toEqual(before);
      const count = async () =>
        Number(
          (
            await db.execute(
              sql.raw(
                `SELECT count(*) AS total FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}'`,
              ),
            )
          ).rows[0]?.total,
        );
      expect(await count()).toBe(failMigration ? 0 : 2);
      expect((await reader.getTrajectoryDetail(trajectoryId))?.steps).toEqual(
        before?.steps,
      );
      expect(await count()).toBe(2);
      expect(await reader.getStats()).toMatchObject({
        byModel: { "legacy-fixture": 2 },
      });
      const exported = await reader.exportTrajectories({
        format: "json",
        includePrompts: true,
        trajectoryIds: [trajectoryId],
      });
      const records = JSON.parse(String(exported.data));
      expect(records).toHaveLength(2);
      expect(JSON.stringify(records) === JSON.stringify(beforeExport)).toBe(
        true,
      );
      // Once rows commit they remain authoritative over the retained snapshot.
      await db.execute(
        sql.raw(
          `UPDATE trajectories SET steps_json = '[]' WHERE id = '${trajectoryId}'`,
        ),
      );
      expect(await reader.getTrajectoryDetail(trajectoryId)).toEqual(before);
    } finally {
      await source.stop();
      await reader.stop();
      await client.close();
    }
  }, 120_000);
}

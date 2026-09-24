/** Exercises host trajectory writes, both public read surfaces and the viewer HTTP formatter against real PGlite. The loopback harness supplies transport only; authentication and live-model generation are outside this storage contract. */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  TrajectoriesService,
  trajectoriesPlugin,
  tryHandleTrajectoryReadRoutes,
} from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/pglite-runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  executeRawSql,
  extractRequiredRows,
  sqlQuote,
} from "../src/runtime/trajectory-internals.ts";
import {
  DatabaseTrajectoryLogger,
  installDatabaseTrajectoryLogger,
} from "../src/runtime/trajectory-storage.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let direct: DatabaseTrajectoryLogger;
let bridge: TrajectoriesService;
let server: Server;
let origin: string;

beforeAll(async () => {
  vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "1");
  vi.stubEnv("ELIZA_DISABLE_TRAJECTORY_LOGGING", undefined);
  fixture = await createTestRuntime({
    characterName: "TrajectoryReadAcceptance",
    plugins: [trajectoriesPlugin],
  });
  await fixture.runtime.getServiceLoadPromise("trajectories");
  const registered =
    fixture.runtime.getService<TrajectoriesService>("trajectories");
  if (!registered) throw new Error("Trajectory service did not start");
  bridge = registered;
  await installDatabaseTrajectoryLogger(fixture.runtime);
  direct = new DatabaseTrajectoryLogger(fixture.runtime);
  direct.setEnabled(true);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void tryHandleTrajectoryReadRoutes({
      pathname: url.pathname,
      method: req.method ?? "GET",
      url,
      runtime: fixture.runtime,
      res,
    })
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      })
      .catch((error) => {
        // error-policy:J1 The real HTTP boundary surfaces an unexpected handler failure.
        res.statusCode = 500;
        res.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (direct) await direct.stop();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
});

it("reads complete persisted calls with the same filters and failures on both logger paths", async () => {
  expect(await direct.getStats()).toEqual({
    total: 0,
    enabled: true,
    byStatus: {},
    bySource: {},
  });
  expect(await bridge.getStats()).toMatchObject({
    totalTrajectories: 0,
    byModel: {},
    bySource: {},
  });
  const roomId = randomUUID();
  const prompt = `complete original request ${"x".repeat(180_000)} FINAL-REQUEST`;
  const trajectoryId = await direct.startTrajectory(fixture.runtime.agentId, {
    source: "read-acceptance",
    roomId,
  });
  const stepId = direct.startStep(trajectoryId, { kind: "llm" });
  direct.logLlmCall({
    stepId,
    model: "fixture",
    purpose: "action",
    actionType: "runtime.useModel",
    systemPrompt: "Preserve the complete record.",
    userPrompt: prompt,
    response: "complete persisted result",
    promptTokens: 7,
    completionTokens: 3,
  });
  await direct.flushWriteQueue(trajectoryId);
  await direct.endTrajectory(trajectoryId, "completed");
  const otherId = await direct.startTrajectory(fixture.runtime.agentId, {
    source: "other-source",
    roomId: randomUUID(),
  });
  await direct.endTrajectory(otherId, "completed");

  const foreignId = randomUUID();
  const stamp = sqlQuote(new Date().toISOString());
  await executeRawSql(
    fixture.runtime,
    `INSERT INTO trajectories (id,trajectory_id,agent_id,source,status,start_time,created_at,updated_at) VALUES (${sqlQuote(foreignId)},${sqlQuote(foreignId)},${sqlQuote(randomUUID())},'read-acceptance','completed',1,${stamp},${stamp})`,
  );
  await executeRawSql(
    fixture.runtime,
    `INSERT INTO trajectory_steps (id, trajectory_id, ordinal, payload)
     SELECT ${sqlQuote(randomUUID())}, ${sqlQuote(foreignId)}, 0, payload
     FROM trajectory_steps WHERE id = ${sqlQuote(stepId)}`,
  );
  await expect(
    bridge.exportTrajectoriesZip({ trajectoryIds: [foreignId] }),
  ).rejects.toMatchObject({
    code: "TRAJECTORY_EXPORT_INCOMPLETE",
  });
  await expect(
    bridge.exportTrajectoriesZip({ trajectoryIds: [randomUUID()] }),
  ).rejects.toMatchObject({
    code: "TRAJECTORY_EXPORT_INCOMPLETE",
  });
  for (const reader of [direct, bridge]) {
    const filtered = await reader.listTrajectories({
      source: "read-acceptance",
      roomId,
      status: "completed",
    });
    expect(filtered.total).toBe(1);
    expect(filtered.trajectories.map((row) => row.id)).toEqual([trajectoryId]);
    const page = await reader.listTrajectories({ limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.trajectories).toHaveLength(1);
    expect(await reader.getTrajectoryDetail(foreignId)).toBeNull();
    expect(await reader.getTrajectoryDetail(randomUUID())).toBeNull();
  }
  expect(await direct.getStats()).toEqual({
    total: 2,
    enabled: true,
    byStatus: { completed: 2 },
    bySource: { "read-acceptance": 1, "other-source": 1 },
  });
  const statsResponse = await fetch(`${origin}/api/trajectories/stats`);
  expect(statsResponse.status).toBe(200);
  expect(await statsResponse.json()).toMatchObject({
    totalTrajectories: 2,
    totalLlmCalls: 1,
    totalPromptTokens: 7,
    totalCompletionTokens: 3,
    byModel: { fixture: 1 },
    bySource: { "read-acceptance": 1, "other-source": 1 },
  });
  // Dedicated steps remain authoritative when the compatibility snapshot is stale.
  await executeRawSql(
    fixture.runtime,
    `UPDATE trajectories SET steps_json = '[]' WHERE id = ${sqlQuote(trajectoryId)}`,
  );
  expect(await bridge.getStats()).toMatchObject({ byModel: { fixture: 1 } });
  const detail = await direct.getTrajectoryDetail(trajectoryId);
  expect(detail).toEqual(await bridge.getTrajectoryDetail(trajectoryId));
  expect(
    detail?.steps
      ?.flatMap((step) => step.llmCalls ?? [])
      .map((call) => call.userPrompt),
  ).toContain(prompt);
  const httpDetail = await fetch(`${origin}/api/trajectories/${trajectoryId}`);
  expect(httpDetail.status).toBe(200);
  expect(await httpDetail.text()).toContain(prompt);
  expect((await fetch(`${origin}/api/trajectories/${foreignId}`)).status).toBe(
    404,
  );

  const reward = {
    trajectoryId,
    idempotencyKey: "read-acceptance-reward",
    reward: 5,
    component: "acceptance",
  };
  expect(
    await Promise.all([direct.applyReward(reward), bridge.applyReward(reward)]),
  ).toEqual([true, true]);
  expect(
    extractRequiredRows(
      await executeRawSql(
        fixture.runtime,
        `SELECT total_reward FROM trajectories WHERE id = ${sqlQuote(trajectoryId)}`,
      ),
    ),
  ).toMatchObject([{ total_reward: 5 }]);
  bridge.setEnabled(false);
  try {
    expect(
      await bridge.applyReward({
        ...reward,
        idempotencyKey: "disabled-reward",
      }),
    ).toBe(false);
  } finally {
    bridge.setEnabled(true);
  }
  expect(await bridge.applyReward({ ...reward, trajectoryId: foreignId })).toBe(
    false,
  );
  expect(
    extractRequiredRows(
      await executeRawSql(
        fixture.runtime,
        `SELECT total_reward FROM trajectories WHERE id = ${sqlQuote(trajectoryId)}`,
      ),
    ),
  ).toMatchObject([{ total_reward: 5 }]);

  await executeRawSql(
    fixture.runtime,
    `UPDATE trajectory_steps SET payload = jsonb_set(payload::jsonb, '{llmCalls,0,model}', '42')::text
     WHERE id = ${sqlQuote(stepId)}`,
  );
  try {
    for (const reader of [direct, bridge]) {
      await expect(reader.getStats()).rejects.toMatchObject({
        code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
      });
    }
    expect((await fetch(`${origin}/api/trajectories/stats`)).status).toBe(500);
  } finally {
    await executeRawSql(
      fixture.runtime,
      `UPDATE trajectory_steps SET payload = jsonb_set(payload::jsonb, '{llmCalls,0,model}', '"fixture"')::text
       WHERE id = ${sqlQuote(stepId)}`,
    );
  }
  // Exercise records that predate dedicated steps, with persisted wide counters.
  await executeRawSql(
    fixture.runtime,
    `UPDATE trajectories SET steps_json = (SELECT jsonb_agg(payload::jsonb ORDER BY ordinal)
      FROM trajectory_steps WHERE trajectory_id = ${sqlQuote(trajectoryId)}),
      total_prompt_tokens = 1073741824 WHERE id = ${sqlQuote(trajectoryId)}`,
  );
  await executeRawSql(
    fixture.runtime,
    `DELETE FROM trajectory_steps WHERE trajectory_id = ${sqlQuote(trajectoryId)}`,
  );
  await executeRawSql(
    fixture.runtime,
    `UPDATE trajectories SET total_prompt_tokens = 1073741824 WHERE id = ${sqlQuote(otherId)}`,
  );
  expect(await bridge.getStats()).toMatchObject({
    byModel: { fixture: 1 },
    totalPromptTokens: 2147483648,
  });
  expect(await direct.getStats()).toMatchObject({
    total: 2,
    byStatus: { completed: 2 },
  });

  await executeRawSql(
    fixture.runtime,
    "ALTER TABLE trajectories RENAME TO trajectories_unavailable",
  );
  try {
    for (const reader of [direct, bridge]) {
      await expect(reader.getStats()).rejects.toMatchObject({
        code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
      });
      await expect(reader.listTrajectories({})).rejects.toMatchObject({
        code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
      });
    }
    expect((await fetch(`${origin}/api/trajectories`)).status).toBe(500);
    expect((await fetch(`${origin}/api/trajectories/stats`)).status).toBe(500);
  } finally {
    await executeRawSql(
      fixture.runtime,
      "ALTER TABLE trajectories_unavailable RENAME TO trajectories",
    );
  }
  expect((await direct.listTrajectories({})).total).toBe(2);
}, 120_000);

it("exports every owned match beyond viewer and archive page sizes", async () => {
  const templateId = await direct.startTrajectory(fixture.runtime.agentId, {
    source: "export-template",
  });
  const templateStep = direct.startStep(templateId, { kind: "llm" });
  direct.logLlmCall({
    stepId: templateStep,
    model: "export-fixture",
    purpose: "action",
    actionType: "runtime.useModel",
    systemPrompt: "Export completely.",
    userPrompt: "original request",
    response: "original response",
  });
  await direct.flushWriteQueue(templateId);
  await direct.endTrajectory(templateId, "completed");
  await executeRawSql(
    fixture.runtime,
    `UPDATE trajectories SET steps_json = (SELECT jsonb_agg(payload::jsonb ORDER BY ordinal)
      FROM trajectory_steps WHERE trajectory_id = ${sqlQuote(templateId)}) WHERE id = ${sqlQuote(templateId)}`,
  );

  await executeRawSql(
    fixture.runtime,
    `INSERT INTO trajectories
    (id, trajectory_id, agent_id, source, status, start_time, end_time, duration_ms,
     steps_json, metrics_json, reward_components_json, metadata_json, created_at, updated_at)
    SELECT 'archive-' || n, 'archive-' || n, agent_id,
      CASE WHEN n <= 501 THEN 'zip-pages' ELSE 'archive-pages' END,
      status, start_time, end_time, duration_ms, steps_json, metrics_json,
      reward_components_json, metadata_json, created_at, updated_at
    FROM trajectories CROSS JOIN generate_series(1, 10001) n
    WHERE id = ${sqlQuote(templateId)}`,
  );
  const zip = await bridge.exportTrajectoriesZip({ source: "zip-pages" });
  expect(
    zip.entries.filter((entry) => entry.name.endsWith("/trajectory.json")),
  ).toHaveLength(501);
  const manifest = zip.entries.find((entry) => entry.name === "manifest.json");
  if (!manifest) throw new Error("ZIP export omitted its manifest");
  const parsedManifest = JSON.parse(manifest.data) as {
    trajectories: { trajectoryId: string }[];
  };
  expect(
    new Set(parsedManifest.trajectories.map((entry) => entry.trajectoryId))
      .size,
  ).toBe(501);
  const independent = new TrajectoriesService(fixture.runtime);
  await independent.initialize();
  try {
    const nativeZip = await independent.exportTrajectoriesZip({
      source: "zip-pages",
    });
    expect(
      nativeZip.entries.filter((entry) =>
        entry.name.endsWith("/trajectory.json"),
      ),
    ).toHaveLength(501);
  } finally {
    await independent.stop();
  }
  const archive = await direct.exportTrajectories({ format: "json" });
  if (typeof archive.data !== "string")
    throw new Error("JSON export did not return text");
  const rows = JSON.parse(archive.data) as { trajectoryId: string }[];
  expect(rows).toHaveLength(10003);
  expect(new Set(rows.map((row) => row.trajectoryId)).size).toBe(10003);
}, 120_000);

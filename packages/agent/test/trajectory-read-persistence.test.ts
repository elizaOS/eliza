/** Exercises host trajectory writes, the trajectory service read surface and the viewer HTTP formatter against real PGlite. The loopback harness supplies transport only; authentication and live-model generation are outside this storage contract. */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AgentRuntime,
  actionToTool,
  ModelType,
  runWithTrajectoryContext,
  withEvaluatorStep,
  withProviderStep,
} from "@elizaos/core";
import { parseTrajectorySemanticStage } from "@elizaos/core/protocol";
import {
  createBaseTrajectory,
  ensureStep,
  executeRawSql,
  extractRequiredRows,
  loadTrajectoryById,
  saveTrajectory,
  sqlQuote,
  type TrajectoriesService,
  trajectoriesPlugin,
  tryHandleTrajectoryReadRoutes,
} from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { proposeDeviceAction } from "../../../plugins/plugin-assistant/src/services/device-actions/action.ts";
import { handleTrajectoryManagementRoutes } from "../src/api/trajectory-management-routes.ts";
import { installPromptOptimizations } from "../src/runtime/prompt-optimization.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let service: TrajectoriesService;
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
  service = registered;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    void handleTrajectoryManagementRoutes({
      req,
      res,
      method,
      pathname: url.pathname,
      runtime: fixture.runtime,
    })
      .then(
        (managed) =>
          managed ||
          tryHandleTrajectoryReadRoutes({
            pathname: url.pathname,
            method,
            url,
            runtime: fixture.runtime,
            res,
          }),
      )
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
  // Keep the loopback fixture alive across the long export test; teardown owns closure.
  server.keepAliveTimeout = 0;
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
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
});

it("reads complete persisted calls with filters and failures on the trajectory service", async () => {
  expect(await service.getStats()).toMatchObject({
    totalTrajectories: 0,
    byModel: {},
    bySource: {},
  });
  const roomId = randomUUID();
  const prompt = `complete original request ${"x".repeat(180_000)} FINAL-REQUEST`;
  const trajectoryId = await service.startTrajectory(fixture.runtime.agentId, {
    source: "read-acceptance",
    roomId,
  });
  const stepId = service.startStep(trajectoryId, { kind: "llm" });
  service.logLlmCall({
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
  await service.flushWriteQueue(trajectoryId);
  await service.endTrajectory(trajectoryId, "completed");
  const otherId = await service.startTrajectory(fixture.runtime.agentId, {
    source: "other-source",
    roomId: randomUUID(),
  });
  await service.endTrajectory(otherId, "completed");

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
    service.exportTrajectoriesZip({ trajectoryIds: [foreignId] }),
  ).rejects.toMatchObject({
    code: "TRAJECTORY_EXPORT_INCOMPLETE",
  });
  await expect(
    service.exportTrajectoriesZip({ trajectoryIds: [randomUUID()] }),
  ).rejects.toMatchObject({
    code: "TRAJECTORY_EXPORT_INCOMPLETE",
  });
  const filtered = await service.listTrajectories({
    source: "read-acceptance",
    roomId,
    status: "completed",
  });
  expect(filtered.total).toBe(1);
  expect(filtered.trajectories.map((row) => row.id)).toEqual([trajectoryId]);
  const page = await service.listTrajectories({ limit: 1, offset: 1 });
  expect(page.total).toBe(2);
  expect(page.trajectories).toHaveLength(1);
  expect(await service.getTrajectoryDetail(foreignId)).toBeNull();
  expect(await service.getTrajectoryDetail(randomUUID())).toBeNull();
  expect((await service.listTrajectories({ status: "completed" })).total).toBe(
    2,
  );
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
  const detail = await service.getTrajectoryDetail(trajectoryId);
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
    await Promise.all([
      service.applyReward(reward),
      service.applyReward(reward),
    ]),
  ).toEqual([true, true]);
  expect(
    extractRequiredRows(
      await executeRawSql(
        fixture.runtime,
        `SELECT total_reward FROM trajectories WHERE id = ${sqlQuote(trajectoryId)}`,
      ),
    ),
  ).toMatchObject([{ total_reward: 5 }]);
  service.setEnabled(false);
  try {
    expect(
      await service.applyReward({
        ...reward,
        idempotencyKey: "disabled-reward",
      }),
    ).toBe(false);
  } finally {
    service.setEnabled(true);
  }
  expect(
    await service.applyReward({ ...reward, trajectoryId: foreignId }),
  ).toBe(false);
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
    await expect(service.getStats()).rejects.toMatchObject({
      code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
    });
    expect((await fetch(`${origin}/api/trajectories/stats`)).status).toBe(500);
  } finally {
    await executeRawSql(
      fixture.runtime,
      `UPDATE trajectory_steps SET payload = jsonb_set(payload::jsonb, '{llmCalls,0,model}', '"fixture"')::text
       WHERE id = ${sqlQuote(stepId)}`,
    );
  }
  // Exercise persisted counters wider than a 32-bit sum.
  for (const id of [trajectoryId, otherId]) {
    await executeRawSql(
      fixture.runtime,
      `UPDATE trajectories SET total_prompt_tokens = 1073741824 WHERE id = ${sqlQuote(id)}`,
    );
  }
  expect(await service.getStats()).toMatchObject({
    byModel: { fixture: 1 },
    totalPromptTokens: 2147483648,
  });
  expect((await service.listTrajectories({ status: "completed" })).total).toBe(
    2,
  );

  await executeRawSql(
    fixture.runtime,
    "ALTER TABLE trajectories RENAME TO trajectories_unavailable",
  );
  try {
    await expect(service.getStats()).rejects.toMatchObject({
      code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
    });
    await expect(service.listTrajectories({})).rejects.toMatchObject({
      code: "TRAJECTORY_STORAGE_OPERATION_FAILED",
    });
    expect((await fetch(`${origin}/api/trajectories`)).status).toBe(500);
    expect((await fetch(`${origin}/api/trajectories/stats`)).status).toBe(500);
  } finally {
    await executeRawSql(
      fixture.runtime,
      "ALTER TABLE trajectories_unavailable RENAME TO trajectories",
    );
  }
  expect((await service.listTrajectories({})).total).toBe(2);
}, 120_000);

it("exports every owned match beyond viewer and archive page sizes", async () => {
  const templateId = await service.startTrajectory(fixture.runtime.agentId, {
    source: "export-template",
  });
  const templateStep = service.startStep(templateId, { kind: "llm" });
  service.logLlmCall({
    stepId: templateStep,
    model: "export-fixture",
    purpose: "action",
    actionType: "runtime.useModel",
    systemPrompt: "Export completely.",
    userPrompt: "original request",
    response: "original response",
  });
  await service.flushWriteQueue(templateId);
  await service.endTrajectory(templateId, "completed");
  await executeRawSql(
    fixture.runtime,
    `INSERT INTO trajectories
    (id, trajectory_id, agent_id, source, status, start_time, end_time, duration_ms,
     metrics_json, reward_components_json, metadata_json, created_at, updated_at)
    SELECT 'archive-' || n, 'archive-' || n, agent_id,
      CASE WHEN n <= 501 THEN 'zip-pages' ELSE 'archive-pages' END,
      status, start_time, end_time, duration_ms, metrics_json,
      reward_components_json, metadata_json, created_at, updated_at
    FROM trajectories CROSS JOIN generate_series(1, 10001) n
    WHERE id = ${sqlQuote(templateId)}`,
  );
  const zip = await service.exportTrajectoriesZip({ source: "zip-pages" });
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
  const archive = await service.exportTrajectories({ format: "json" });
  if (typeof archive.data !== "string")
    throw new Error("JSON export did not return text");
  const rows = JSON.parse(archive.data) as { trajectoryId: string }[];
  expect(rows).toHaveLength(10003);
  expect(new Set(rows.map((row) => row.trajectoryId)).size).toBe(10003);
}, 120_000);

async function createStepWriteTrajectory() {
  const trajectory = createBaseTrajectory(
    randomUUID(),
    Date.now(),
    fixture.runtime.agentId,
    "step-write-confirmation",
  );
  trajectory.steps = [];
  await saveTrajectory(fixture.runtime, trajectory, {
    createOnly: true,
    changedStepIds: [],
  });
  return trajectory;
}

it("confirms owned step inserts and updates with same-batch and existing parents", async () => {
  const trajectory = await createStepWriteTrajectory();
  const expectedUpdatedAt = trajectory.updatedAt;
  const parent = ensureStep(trajectory, randomUUID(), Date.now());
  parent.script = "parent original";
  const child = ensureStep(trajectory, randomUUID(), Date.now());
  child.parentStepId = parent.stepId;
  child.script = "child original";
  const sibling = ensureStep(trajectory, randomUUID(), Date.now());
  sibling.parentStepId = parent.stepId;
  trajectory.updatedAt = new Date(
    Date.parse(expectedUpdatedAt) + 1,
  ).toISOString();

  await expect(
    saveTrajectory(fixture.runtime, trajectory, {
      changedStepIds: [parent.stepId, child.stepId, sibling.stepId],
      requireActiveExisting: true,
      expectedUpdatedAt,
    }),
  ).resolves.toBe(true);
  const inserted = await loadTrajectoryById(fixture.runtime, trajectory.id);
  expect(inserted?.steps).toHaveLength(3);
  expect(
    inserted?.steps.find((step) => step.stepId === child.stepId),
  ).toMatchObject({
    parentStepId: parent.stepId,
    script: "child original",
  });

  const updateRevision = trajectory.updatedAt;
  child.script = "child changed";
  trajectory.updatedAt = new Date(Date.parse(updateRevision) + 1).toISOString();
  await expect(
    saveTrajectory(fixture.runtime, trajectory, {
      changedStepIds: [child.stepId],
      requireActiveExisting: true,
      expectedUpdatedAt: updateRevision,
    }),
  ).resolves.toBe(true);
  const updated = await loadTrajectoryById(fixture.runtime, trajectory.id);
  expect(
    updated?.steps.find((step) => step.stepId === child.stepId)?.script,
  ).toBe("child changed");
  expect(
    updated?.steps.find((step) => step.stepId === parent.stepId)?.script,
  ).toBe("parent original");
  expect(updated?.steps).toHaveLength(3);
});

it("rolls back the parent and earlier child when a guarded write finds a foreign step", async () => {
  const trajectory = await createStepWriteTrajectory();
  const foreign = await createStepWriteTrajectory();
  const shared = ensureStep(foreign, randomUUID(), Date.now());
  shared.script = "foreign unchanged";
  await saveTrajectory(fixture.runtime, foreign, {
    changedStepIds: [shared.stepId],
  });
  const before = await loadTrajectoryById(fixture.runtime, trajectory.id);
  const foreignBefore = await loadTrajectoryById(fixture.runtime, foreign.id);
  if (!before) throw new Error("Fixture trajectory missing");
  const good = ensureStep(trajectory, randomUUID(), Date.now());
  const conflicting = ensureStep(trajectory, shared.stepId, Date.now());
  conflicting.script = "must not overwrite";
  trajectory.metadata = { mustRollback: true };
  trajectory.updatedAt = new Date(
    Date.parse(trajectory.updatedAt) + 1,
  ).toISOString();

  await expect(
    saveTrajectory(fixture.runtime, trajectory, {
      changedStepIds: [good.stepId, conflicting.stepId],
      requireActiveExisting: true,
      expectedUpdatedAt: before.updatedAt,
    }),
  ).rejects.toMatchObject({ code: "TRAJECTORY_STEP_OWNERSHIP_CONFLICT" });
  expect(await loadTrajectoryById(fixture.runtime, trajectory.id)).toEqual(
    before,
  );
  expect(await loadTrajectoryById(fixture.runtime, foreign.id)).toEqual(
    foreignBefore,
  );
  expect(
    extractRequiredRows(
      await executeRawSql(
        fixture.runtime,
        `SELECT id FROM trajectory_steps WHERE id = ${sqlQuote(good.stepId)}`,
      ),
    ),
  ).toEqual([]);
});

it("rejects a real trigger-suppressed step write and rolls back its parent", async () => {
  const trajectory = await createStepWriteTrajectory();
  const before = await loadTrajectoryById(fixture.runtime, trajectory.id);
  if (!before) throw new Error("Fixture trajectory missing");
  const step = ensureStep(trajectory, randomUUID(), Date.now());
  trajectory.metadata = { mustRollback: true };
  trajectory.updatedAt = new Date(
    Date.parse(trajectory.updatedAt) + 1,
  ).toISOString();
  await executeRawSql(
    fixture.runtime,
    `
    CREATE FUNCTION suppress_fixture_trajectory_step() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = ${sqlQuote(step.stepId)} THEN RETURN NULL; END IF;
      RETURN NEW;
    END $$`,
  );
  await executeRawSql(
    fixture.runtime,
    `
    CREATE TRIGGER suppress_fixture_trajectory_step
    BEFORE INSERT ON trajectory_steps FOR EACH ROW
    EXECUTE FUNCTION suppress_fixture_trajectory_step()`,
  );
  try {
    await expect(
      saveTrajectory(fixture.runtime, trajectory, {
        changedStepIds: [step.stepId],
        requireActiveExisting: true,
        expectedUpdatedAt: before.updatedAt,
      }),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_STEPS_SAVE_FAILED",
      cause: { code: "TRAJECTORY_STEP_WRITE_UNCONFIRMED" },
    });
    expect(await loadTrajectoryById(fixture.runtime, trajectory.id)).toEqual(
      before,
    );
  } finally {
    await executeRawSql(
      fixture.runtime,
      "DROP TRIGGER suppress_fixture_trajectory_step ON trajectory_steps",
    );
    await executeRawSql(
      fixture.runtime,
      "DROP FUNCTION suppress_fixture_trajectory_step()",
    );
  }
});

it.each(["missing", "foreign", "self"] as const)(
  "preserves %s parent-step rejection and full transaction rollback",
  async (parentKind) => {
    const trajectory = await createStepWriteTrajectory();
    const foreign = await createStepWriteTrajectory();
    const foreignParent = ensureStep(foreign, randomUUID(), Date.now());
    await saveTrajectory(fixture.runtime, foreign, {
      changedStepIds: [foreignParent.stepId],
    });
    const before = await loadTrajectoryById(fixture.runtime, trajectory.id);
    if (!before) throw new Error("Fixture trajectory missing");
    const earlier = ensureStep(trajectory, randomUUID(), Date.now());
    const child = ensureStep(trajectory, randomUUID(), Date.now());
    child.parentStepId =
      parentKind === "self"
        ? child.stepId
        : parentKind === "foreign"
          ? foreignParent.stepId
          : randomUUID();
    await expect(
      saveTrajectory(fixture.runtime, trajectory, {
        changedStepIds: [earlier.stepId, child.stepId],
        requireActiveExisting: true,
        expectedUpdatedAt: before.updatedAt,
      }),
    ).rejects.toMatchObject({ code: "TRAJECTORY_STEP_PARENT_INVALID" });
    expect(await loadTrajectoryById(fixture.runtime, trajectory.id)).toEqual(
      before,
    );
    expect(
      extractRequiredRows(
        await executeRawSql(
          fixture.runtime,
          `SELECT id FROM trajectory_steps WHERE id = ${sqlQuote(earlier.stepId)}`,
        ),
      ),
    ).toEqual([]);
  },
);

it("retains the parent revision conflict before any child can be written", async () => {
  const trajectory = await createStepWriteTrajectory();
  const expectedUpdatedAt = trajectory.updatedAt;
  const changedAt = new Date(Date.parse(expectedUpdatedAt) + 1).toISOString();
  await executeRawSql(
    fixture.runtime,
    `UPDATE trajectories SET updated_at = ${sqlQuote(changedAt)}
    WHERE id = ${sqlQuote(trajectory.id)}`,
  );
  const before = await loadTrajectoryById(fixture.runtime, trajectory.id);
  const child = ensureStep(trajectory, randomUUID(), Date.now());
  await expect(
    saveTrajectory(fixture.runtime, trajectory, {
      changedStepIds: [child.stepId],
      requireActiveExisting: true,
      expectedUpdatedAt,
    }),
  ).rejects.toMatchObject({ code: "TRAJECTORY_WRITE_CONFLICT" });
  expect(await loadTrajectoryById(fixture.runtime, trajectory.id)).toEqual(
    before,
  );
});

it("persists and reads complete planner stages with the canonical native proposal schema", async () => {
  const trajectoryId = await service.startTrajectory(fixture.runtime.agentId, {
    source: "semantic-schema-acceptance",
    roomId: randomUUID(),
  });
  const stepId = service.startStep(trajectoryId, { kind: "llm" });
  await service.flushWriteQueue(trajectoryId);
  const schema = actionToTool(proposeDeviceAction).function.parameters;
  const messages = [
    {
      role: "user" as const,
      content: "Complete input " + "x".repeat(120_000) + " FINAL-INPUT",
    },
  ];
  const providerOptions = {
    eliza: { plannerActionSchemas: { PROPOSE_DEVICE_ACTION: schema } },
  };
  service.logSemanticStage({
    stepId,
    stage: {
      stageId: "native-schema-planner",
      kind: "planner",
      startedAt: 1,
      endedAt: 2,
      latencyMs: 1,
      model: {
        modelType: "TEXT_LARGE",
        messages,
        providerOptions,
        response: "Recorded without removing inputs",
      },
    },
  });
  await service.flushWriteQueue(trajectoryId);
  const detail = await service.getTrajectoryDetail(trajectoryId);
  const semantic = detail?.steps?.flatMap((step) => step.semanticStages ?? []);
  expect(semantic).toHaveLength(1);
  expect(semantic?.[0].payload.model).toMatchObject({
    messages,
    providerOptions,
  });
  const response = await fetch(`${origin}/api/trajectories/${trajectoryId}`);
  expect(response.status).toBe(200);
  const read = await response.json();
  expect(JSON.stringify(read)).toContain("FINAL-INPUT");
  expect(JSON.stringify(read)).toContain(JSON.stringify(schema));
});

it("validates deep semantic JSON without stack limits while retaining type, prototype and cycle guards", () => {
  const envelope = (model: unknown) => ({
    schemaVersion: 1,
    stageId: "deep-stage",
    kind: "planner",
    startedAt: 1,
    endedAt: 2,
    latencyMs: 1,
    payload: { model },
  });
  let deep: unknown = "deepest-input";
  for (let index = 0; index < 25_000; index++) deep = { child: deep };
  const parsed = parseTrajectorySemanticStage(envelope(deep));
  expect(parsed.payload.model).toBe(deep);
  const shared = { value: [null, true, 3, "complete"] };
  const aliases = parseTrajectorySemanticStage(
    envelope({ left: shared, right: shared }),
  );
  expect(aliases.payload.model).toEqual({ left: shared, right: shared });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const arrayCycle: unknown[] = [];
  arrayCycle.push(arrayCycle);
  for (const invalid of [
    cycle,
    arrayCycle,
    NaN,
    Infinity,
    undefined,
    1n,
    Symbol("not-json"),
    () => 1,
    new Date(),
    new Map(),
    Object.create({ inherited: true }),
  ]) {
    expect(() =>
      parseTrajectorySemanticStage(envelope({ nested: invalid })),
    ).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_SEMANTIC_STAGE_INVALID" }),
    );
  }
  const ownProto = JSON.parse(
    '{"__proto__":{"preserved":"data"},"constructor":"data"}',
  );
  const safe = parseTrajectorySemanticStage(envelope(ownProto));
  expect(safe.payload.model).toBe(ownProto);
  expect(Object.getPrototypeOf(ownProto)).toBe(Object.prototype);
  expect(Object.hasOwn(ownProto, "__proto__")).toBe(true);
});

it("records every planner, evaluator and concurrent provider model call with its own usage and prompt telemetry", async () => {
  const { useModel } = fixture.runtime;
  installPromptOptimizations(fixture.runtime as AgentRuntime);
  // The later tests of this file use the runtime without the wrapper.
  onTestFinished(() => {
    fixture.runtime.useModel = useModel;
  });
  const usage = { promptTokens: 11, completionTokens: 5, totalTokens: 16 };
  for (const modelType of [
    ModelType.ACTION_PLANNER,
    ModelType.TEXT_SMALL,
    ModelType.TEXT_TOKENIZER_ENCODE,
  ]) {
    fixture.runtime.registerModel(
      modelType,
      async () => ({ text: "fixture reply", usage }),
      "ledger-fixture",
    );
  }
  const trajectoryId = await service.startTrajectory(fixture.runtime.agentId, {
    source: "model-call-ledger",
    roomId: randomUUID(),
  });
  const stepId = service.startStep(trajectoryId, { kind: "llm" });
  await service.flushWriteQueue(trajectoryId);
  const prompts = [
    "first planner request",
    "second planner request, a little longer",
    "evaluate the finished turn",
    "summarize inside a provider",
    "summarize again inside the same provider",
    "summarize inside another provider",
    "tokenize inside a third provider",
  ];
  await runWithTrajectoryContext(
    { trajectoryId, trajectoryStepId: stepId },
    async () => {
      for (const prompt of prompts.slice(0, 2)) {
        // As in a real turn, a queued provider capture delays the call's write.
        service.logProviderAccess({
          stepId,
          providerName: "LEDGER_PROVIDER",
          purpose: "compose",
          data: { text: "provider output" },
        });
        await fixture.runtime.useModel(ModelType.ACTION_PLANNER, { prompt });
      }
      await withEvaluatorStep(fixture.runtime, "LEDGER_EVALUATOR", () =>
        fixture.runtime.useModel(ModelType.TEXT_SMALL, { prompt: prompts[2] }),
      );
      // Three providers run at once. One makes two concurrent calls on its own
      // step, and the first call of another is not a text generation call.
      await Promise.all([
        withProviderStep(fixture.runtime, "LEDGER_PROVIDER", () =>
          Promise.all(
            prompts
              .slice(3, 5)
              .map((prompt) =>
                fixture.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
              ),
          ),
        ),
        withProviderStep(fixture.runtime, "OTHER_PROVIDER", () =>
          fixture.runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: prompts[5],
          }),
        ),
        withProviderStep(fixture.runtime, "TOKENIZER_PROVIDER", () =>
          fixture.runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
            prompt: prompts[6],
            modelType: ModelType.TEXT_SMALL,
          }),
        ),
      ]);
    },
  );
  await service.flushWriteQueue(trajectoryId);
  const calls = (
    await service.getTrajectoryDetail(trajectoryId)
  )?.steps?.flatMap((step) => step.llmCalls ?? []);
  expect(
    calls?.map((call) => [
      call.userPrompt,
      call.promptTokens,
      call.completionTokens,
      (
        call.providerMetadata as
          | { promptOptimization?: { originalPromptChars?: number } }
          | undefined
      )?.promptOptimization?.originalPromptChars,
    ]),
  ).toEqual(prompts.map((prompt) => [prompt, 11, 5, prompt.length]));
  for (const call of calls ?? []) {
    expect(call.providerMetadata).toMatchObject({
      promptOptimization: {
        originalPromptTokens: expect.any(Number),
        finalPromptTokens: expect.any(Number),
      },
    });
  }
  await service.endTrajectory(trajectoryId, "completed");
});

it("redacts the text that a model-call update fills in as it redacts a call record", async () => {
  const trajectoryId = await service.startTrajectory(fixture.runtime.agentId, {
    source: "model-call-update-redaction",
    roomId: randomUUID(),
  });
  const stepId = service.startStep(trajectoryId, { kind: "llm" });
  const callId = randomUUID();
  const privateText = "write to ada@example.com, card 4111111111111111";
  service.logLlmCall({
    stepId,
    callId,
    model: "fixture",
    purpose: "action",
    actionType: "runtime.useModel",
    systemPrompt: privateText,
    userPrompt: "",
    response: "",
  });
  service.updateLlmCall(stepId, callId, {
    userPrompt: privateText,
    response: privateText,
    providerMetadata: {
      promptOptimization: { budgetTokens: 1000, outputReserveTokens: 100 },
      accessToken: "fixture-private-credential",
    },
  });
  await service.flushWriteQueue(trajectoryId);
  const [call] =
    (await service.getTrajectoryDetail(trajectoryId))?.steps?.flatMap(
      (step) => step.llmCalls ?? [],
    ) ?? [];
  expect([call?.systemPrompt, call?.userPrompt, call?.response]).toEqual(
    Array(3).fill("write to <EMAIL>, card <CARD>"),
  );
  expect(call?.providerMetadata).toMatchObject({
    promptOptimization: { budgetTokens: 1000, outputReserveTokens: 100 },
    accessToken: "[REDACTED]",
  });
  await service.endTrajectory(trajectoryId, "completed");
});

it("serves the viewer's config, export and delete requests from the registered service", async () => {
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });

  const config = await send("GET", "/api/trajectories/config");
  expect(config.status).toBe(200);
  expect(await config.json()).toEqual({ enabled: service.isEnabled() });
  const disabled = await send("PUT", "/api/trajectories/config", {
    enabled: false,
  });
  expect(await disabled.json()).toEqual({ enabled: false });
  expect(service.isEnabled()).toBe(false);
  const enabled = await send("PUT", "/api/trajectories/config", {
    enabled: true,
  });
  expect(await enabled.json()).toEqual({ enabled: true });
  expect(service.isEnabled()).toBe(true);
  expect(
    (await send("PUT", "/api/trajectories/config", { enabled: "yes" })).status,
  ).toBe(400);

  const source = `management-${randomUUID()}`;
  const record = async (): Promise<string> => {
    const id = await service.startTrajectory(fixture.runtime.agentId, {
      source,
    });
    service.logLlmCall({
      stepId: service.startStep(id, { kind: "llm" }),
      model: "fixture",
      purpose: "action",
      actionType: "runtime.useModel",
      systemPrompt: "system",
      userPrompt: "request",
      response: "result",
      promptTokens: 1,
      completionTokens: 1,
    });
    await service.flushWriteQueue(id);
    await service.endTrajectory(id, "completed");
    return id;
  };
  const kept = await record();
  const removed = await record();

  const exported = await send("POST", "/api/trajectories/export", {
    format: "json",
    source,
  });
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-disposition")).toContain("attachment");
  const rows = (await exported.json()) as { trajectoryId: string }[];
  expect(rows.map((row) => row.trajectoryId).sort()).toEqual(
    [kept, removed].sort(),
  );
  const zip = await send("POST", "/api/trajectories/export", {
    format: "zip",
    source,
  });
  expect(zip.status).toBe(200);
  expect(zip.headers.get("content-type")).toBe("application/zip");
  expect(
    Buffer.from(await zip.arrayBuffer())
      .subarray(0, 2)
      .toString("latin1"),
  ).toBe("PK");
  expect(
    (await send("POST", "/api/trajectories/export", { format: "xml" })).status,
  ).toBe(400);

  // An empty selection is rejected rather than reported as a zero-row success.
  expect((await send("DELETE", "/api/trajectories", {})).status).toBe(400);
  expect(
    (await send("DELETE", "/api/trajectories", { trajectoryIds: [] })).status,
  ).toBe(400);
  const deleted = await send("DELETE", "/api/trajectories", {
    trajectoryIds: [removed],
  });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: 1 });
  const remaining = await service.listTrajectories({ source });
  expect(remaining.trajectories.map((row) => row.id)).toEqual([kept]);
}, 120_000);

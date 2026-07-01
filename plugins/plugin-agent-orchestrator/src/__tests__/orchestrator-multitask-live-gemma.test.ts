import { describe, expect, it } from "vitest";
import {
  makeGrillingRuntime,
  makeScriptedAcp,
  OrchestratorTaskService,
  waitFor,
} from "../../test/scenarios/_helpers/orchestrator-grilling-harness.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

/**
 * LIVE concurrency QA: drive the real OrchestratorTaskService with THREE
 * concurrent tasks + interleaved completion events + noise (events for
 * unrelated sessions), all judged by a real Cerebras `gemma-4-31b`. Proves
 * per-task isolation under load: each task is grilled/verified on ITS OWN
 * evidence against ITS OWN criteria, and noise is ignored. Gated behind
 * `CEREBRAS_API_KEY`; skipped in keyless CI.
 */
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY?.trim() ?? "";
const MODEL = process.env.GEMMA_MODEL?.trim() || "gemma-4-31b";
const BASE_URL =
  process.env.CEREBRAS_BASE_URL?.trim() || "https://api.cerebras.ai/v1";

async function gemma(...args: unknown[]): Promise<string> {
  const opts = args[1] as { prompt?: string } | undefined;
  const prompt = opts?.prompt ?? "";
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CEREBRAS_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 700,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`Cerebras ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

function baseRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-00000000mt01",
    character: { name: "MultiTask" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    getService: () => undefined,
    useModel: async () => "{}",
  } as never;
}

/** A strong, internally-consistent completion (verified live to pass gemma). */
const strong = (file: string, tests: number) => `Done.
\`\`\`diff
diff --git a/${file} b/${file}
+// implementation
\`\`\`
\`\`\`
$ npm test
 Test Files  1 passed (1)
      Tests  ${tests} passed (${tests})
\`\`\`
`;

async function seedTask(
  store: OrchestratorTaskStore,
  n: number,
  goal: string,
): Promise<{ taskId: string; sessionId: string }> {
  const detail = await store.createTask({
    title: `Task ${n}`,
    goal,
    acceptanceCriteria: ["tests pass"],
    roomId: `room-${n}`,
    taskRoomId: `task-room-${n}`,
    worldId: "mt-world",
  });
  const taskId = detail.task.id;
  const sessionId = `mt-sess-${n}`;
  const now = Date.now();
  await store.addSession({
    id: `mt-row-${n}`,
    taskId,
    sessionId,
    framework: "opencode",
    label: `Agent-${n}`,
    originalTask: goal,
    workdir: `/tmp/mt-${n}`,
    status: "ready",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: false,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  await store.updateTask(taskId, { status: "active" });
  return { taskId, sessionId };
}

describe.skipIf(!CEREBRAS_KEY)(
  `orchestrator multi-task isolation — LIVE ${MODEL} (Cerebras)`,
  () => {
    it("grills/verifies three concurrent tasks independently under interleaved events + noise", async () => {
      const store = new OrchestratorTaskStore({ backend: "memory" });
      const acp = makeScriptedAcp();
      const runtime = makeGrillingRuntime(baseRuntime(), acp.service, gemma);
      const service = new OrchestratorTaskService(runtime, { store });
      await service.start();
      const prevAuto = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
      process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "1";
      try {
        const a = await seedTask(store, 1, "Add a rate limiter to the API");
        const b = await seedTask(store, 2, "Fix the date parsing bug");
        const c = await seedTask(
          store,
          3,
          "Add pagination to the list endpoint",
        );

        // Interleave: A weak (grill), B strong (pass), + noise, C strong (pass).
        acp.emit(a.sessionId, "task_complete", {
          response: "I added a rate limiter, it should be fine.",
        });
        acp.emit("noise-session-xyz", "tool_running", {
          toolCall: { title: "ls" },
        });
        acp.emit(b.sessionId, "task_complete", {
          response: strong("src/date.ts", 4),
        });
        acp.emit("noise-session-xyz", "task_complete", {
          response: "unrelated",
        });
        acp.emit(c.sessionId, "task_complete", {
          response: strong("src/list.ts", 6),
        });

        const bDone = await waitFor(
          async () => (await store.getTask(b.taskId))?.task.status === "done",
          { timeoutMs: 60000 },
        );
        const cDone = await waitFor(
          async () => (await store.getTask(c.taskId))?.task.status === "done",
          { timeoutMs: 60000 },
        );
        expect(bDone).toBe(true);
        expect(cDone).toBe(true);
        // The weak task was NOT rubber-stamped by another task's evidence.
        expect((await store.getTask(a.taskId))?.task.status).not.toBe("done");
      } finally {
        if (prevAuto === undefined)
          delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
        else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = prevAuto;
        await service.stop().catch(() => undefined);
      }
    }, 180_000);
  },
);

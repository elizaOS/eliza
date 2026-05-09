import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import type { SwarmCoordinator } from "@elizaos/plugin-agent-orchestrator";
import { PTYService } from "@elizaos/plugin-agent-orchestrator";
import { createTestRuntime } from "../helpers/pglite-runtime";

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 30_000,
  intervalMs = 200,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

let runtime: AgentRuntime | undefined;
let cleanupRuntime: (() => Promise<void>) | undefined;
let service: PTYService | undefined;
let sessionIdToStop: string | null = null;
let workdir: string | undefined;

async function cleanup(): Promise<void> {
  try {
    if (sessionIdToStop && service) {
      await service.stopSession(sessionIdToStop, true);
    }
  } catch {}

  try {
    if (service) {
      await service.stop();
    }
  } catch {}

  try {
    if (cleanupRuntime) {
      await cleanupRuntime();
    }
  } catch {}

  if (workdir) {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  ({ runtime, cleanup: cleanupRuntime } = await createTestRuntime());
  service = await PTYService.start(runtime);
  (runtime.services as Map<string, unknown[]>).set("PTY_SERVICE", [
    service as unknown,
  ]);

  const coordinator = service.coordinator as SwarmCoordinator | null;
  assert.ok(coordinator, "Expected PTYService to wire a SwarmCoordinator");

  const researchThread = await coordinator.createTaskThread({
    title: "Research browser automation frameworks",
    originalRequest:
      "Compare Playwright and Puppeteer and summarize the tradeoffs for browser automation.",
    metadata: {
      source: "task-thread-integration-script",
    },
  });

  assert.equal(
    researchThread.kind,
    "research",
    "expected non-coding task kinds to persist as research",
  );

  workdir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-task-thread-integration-"),
  );
  const outputFile = path.join(workdir, "integration-output.txt");
  const sentinel = `REAL_PTY_DB_TEST_${Date.now()}`;

  const codingThread = await coordinator.createTaskThread({
    title: "Implement durable task-thread capture",
    originalRequest:
      "Create a local artifact that proves PTY output and task state are persisted.",
    metadata: {
      repo: "https://github.com/example/eliza",
      source: "task-thread-integration-script",
    },
  });

  assert.equal(
    codingThread.kind,
    "coding",
    "expected repo-backed execution tasks to persist as coding",
  );

  const session = await service.spawnSession({
    name: "task-thread-integration-shell",
    agentType: "shell",
    workdir,
    metadata: {
      label: "task-thread-integration-shell",
      threadId: codingThread.id,
      requestedType: "shell",
    },
  });
  sessionIdToStop = session.id;

  await coordinator.registerTask(session.id, {
    threadId: codingThread.id,
    agentType: "shell",
    label: "task-thread-integration-shell",
    originalTask:
      "Create the integration artifact and echo the sentinel so the transcript captures it.",
    workdir,
  });

  await waitFor(async () => {
    const output = await service.getSessionOutput(session.id);
    return output.trim().length > 0;
  }, "expected the shell PTY session to become interactive");

  await service.sendToSession(
    session.id,
    `printf '%s\\n' ${JSON.stringify(sentinel)} > ${JSON.stringify(outputFile)}; ` +
      `echo ${JSON.stringify(sentinel)}\n`,
  );

  await waitFor(async () => {
    if (!fs.existsSync(outputFile)) {
      return false;
    }
    const detail = await coordinator.getTaskThread(codingThread.id);
    return Boolean(
      detail &&
        detail.sessions.length === 1 &&
        detail.transcripts.some((entry) => entry.content.includes(sentinel)) &&
        detail.events.some((event) => event.eventType === "task_registered"),
    );
  }, "expected PTY-backed task state to be persisted in the thread detail");

  assert.equal(
    fs.readFileSync(outputFile, "utf8").trim(),
    sentinel,
    "expected the shell PTY session to create the requested artifact",
  );

  await coordinator.taskRegistry.upsertPendingDecision({
    sessionId: session.id,
    threadId: codingThread.id,
    promptText: "Approve the final deploy?",
    recentOutput: "Validation completed, waiting for user confirmation",
    llmDecision: {
      action: "respond",
      response: "yes",
      reasoning: "The implementation and validation artifacts are complete.",
    },
    taskContext: {
      threadId: codingThread.id,
      sessionId: session.id,
      agentType: "shell",
      label: "task-thread-integration-shell",
      originalTask: "Complete the final deploy step",
      workdir,
      status: "blocked",
    },
  });

  const pendingDetail = await coordinator.getTaskThread(codingThread.id);
  assert.equal(
    pendingDetail?.pendingDecisions.length,
    1,
    "expected pending user input to be part of the durable thread detail",
  );
  assert.equal(
    pendingDetail?.pendingDecisions[0]?.promptText,
    "Approve the final deploy?",
  );

  await coordinator.archiveTaskThread(codingThread.id);
  const archivedDetail = await coordinator.getTaskThread(codingThread.id);
  assert.equal(archivedDetail?.status, "archived");

  const archivedSearch = await coordinator.listTaskThreads({
    includeArchived: true,
    search: "durable task-thread capture",
  });
  assert.ok(
    archivedSearch.some((thread) => thread.id === codingThread.id),
    "expected archived task search to find the thread",
  );

  await coordinator.reopenTaskThread(codingThread.id);
  const reopenedDetail = await coordinator.getTaskThread(codingThread.id);
  assert.equal(reopenedDetail?.status, "active");

  await coordinator.taskRegistry.recoverInterruptedTasks();
  const recoveredDetail = await coordinator.getTaskThread(codingThread.id);
  assert.equal(recoveredDetail?.status, "interrupted");
  assert.equal(recoveredDetail?.sessions[0]?.status, "interrupted");
  assert.ok(
    recoveredDetail?.events.some(
      (event) => event.eventType === "session_interrupted",
    ),
    "expected recovery to persist an interrupted-session event",
  );

  console.log(
    "[orchestrator-task-thread-integration] PASS",
    JSON.stringify({
      researchThreadId: researchThread.id,
      codingThreadId: codingThread.id,
      sessionId: session.id,
      outputFile,
    }),
  );
}

try {
  await main();
  await cleanup();
  process.exit(0);
} catch (error) {
  console.error("[orchestrator-task-thread-integration] FAIL");
  console.error(error);
  await cleanup();
  process.exit(1);
}

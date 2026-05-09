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
let pgliteDir: string | undefined;

async function cleanup(options?: {
  removePgliteDir?: boolean;
  removeWorkdir?: boolean;
}): Promise<void> {
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

  if (options?.removeWorkdir && workdir) {
    fs.rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }

  if (options?.removePgliteDir && pgliteDir) {
    fs.rmSync(pgliteDir, { recursive: true, force: true });
    pgliteDir = undefined;
  }

  runtime = undefined;
  cleanupRuntime = undefined;
  service = undefined;
  sessionIdToStop = null;
}

async function startRuntime(): Promise<SwarmCoordinator> {
  const created = await createTestRuntime({
    pgliteDir,
    removePgliteDirOnCleanup: false,
  });
  runtime = created.runtime;
  cleanupRuntime = created.cleanup;
  pgliteDir = created.pgliteDir;
  service = await PTYService.start(runtime);
  (runtime.services as Map<string, unknown[]>).set("PTY_SERVICE", [
    service as unknown,
  ]);
  const coordinator = service.coordinator as SwarmCoordinator | null;
  assert.ok(coordinator, "Expected PTYService to wire a SwarmCoordinator");
  return coordinator;
}

async function main(): Promise<void> {
  pgliteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-task-thread-restart-db-"),
  );
  workdir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-task-thread-restart-workdir-"),
  );

  const outputFile = path.join(workdir, "restart-output.txt");
  const sentinel = `REAL_RESTART_PERSISTENCE_${Date.now()}`;

  const coordinatorA = await startRuntime();
  const thread = await coordinatorA.createTaskThread({
    title: "Persist a task across runtime restart",
    originalRequest:
      "Create a local artifact and make sure the task still exists after restart.",
    metadata: {
      repo: "https://github.com/example/eliza",
      source: "task-thread-restart-script",
    },
  });

  const session = await service?.spawnSession({
    name: "task-thread-restart-shell",
    agentType: "shell",
    workdir,
    metadata: {
      label: "task-thread-restart-shell",
      threadId: thread.id,
      requestedType: "shell",
    },
  });
  sessionIdToStop = session.id;

  await coordinatorA.registerTask(session.id, {
    threadId: thread.id,
    agentType: "shell",
    label: "task-thread-restart-shell",
    originalTask:
      "Create the restart artifact and echo the sentinel so restart persistence is observable.",
    workdir,
  });

  await waitFor(async () => {
    const output = await service?.getSessionOutput(session.id);
    return output.trim().length > 0;
  }, "expected the first shell PTY session to become interactive");

  await service?.sendToSession(
    session.id,
    `printf '%s\\n' ${JSON.stringify(sentinel)} > ${JSON.stringify(outputFile)}; ` +
      `echo ${JSON.stringify(sentinel)}\n`,
  );

  await waitFor(async () => {
    if (!fs.existsSync(outputFile)) {
      return false;
    }
    const detail = await coordinatorA.getTaskThread(thread.id);
    return Boolean(
      detail &&
        detail.sessions.length === 1 &&
        detail.transcripts.some((entry) => entry.content.includes(sentinel)),
    );
  }, "expected runtime A to persist transcript and artifact state");

  await coordinatorA.taskRegistry.upsertPendingDecision({
    sessionId: session.id,
    threadId: thread.id,
    promptText: "Should the task continue after restart?",
    recentOutput: "Waiting for a resumed runtime to continue",
    llmDecision: {
      action: "respond",
      response: "continue",
      reasoning: "The task should remain resumable after restart.",
    },
    taskContext: {
      threadId: thread.id,
      sessionId: session.id,
      agentType: "shell",
      label: "task-thread-restart-shell",
      originalTask: "Continue after restart",
      workdir,
      status: "blocked",
    },
  });

  await cleanup();

  const coordinatorB = await startRuntime();
  const detail = await coordinatorB.getTaskThread(thread.id);
  assert.ok(detail, "expected the task thread to survive a runtime restart");
  assert.equal(detail.status, "interrupted");
  assert.equal(detail.sessions.length, 1);
  assert.ok(
    detail.sessions[0] &&
      ["interrupted", "stopped"].includes(detail.sessions[0].status),
    "expected the restarted task session to remain in a terminal recovered state",
  );
  assert.ok(
    detail.transcripts.some((entry) => entry.content.includes(sentinel)),
    "expected the PTY transcript to survive restart",
  );
  assert.ok(
    detail.pendingDecisions.some(
      (entry) => entry.promptText === "Should the task continue after restart?",
    ),
    "expected pending confirmation state to survive restart",
  );
  assert.equal(
    fs.readFileSync(outputFile, "utf8").trim(),
    sentinel,
    "expected the shell-created artifact to remain on disk after restart",
  );
  assert.equal(coordinatorB.getPendingConfirmations().length, 1);

  const snapshot = await coordinatorB.getTaskContextSnapshot(session.id);
  assert.ok(
    snapshot,
    "expected a persisted task context snapshot after restart",
  );
  assert.ok(
    snapshot && ["blocked", "stopped"].includes(snapshot.status),
    "expected restart recovery to expose either a blocked pending task or a stopped persisted snapshot",
  );

  const threadList = await coordinatorB.listTaskThreads({
    search: "persist a task across runtime restart",
  });
  assert.ok(
    threadList.some((entry) => entry.id === thread.id),
    "expected the restarted coordinator to list the persisted thread",
  );

  console.log(
    "[orchestrator-task-thread-restart] PASS",
    JSON.stringify({
      threadId: thread.id,
      sessionId: session.id,
      pgliteDir,
      outputFile,
    }),
  );

  await cleanup({ removePgliteDir: true, removeWorkdir: true });
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("[orchestrator-task-thread-restart] FAIL");
  console.error(error);
  await cleanup({ removePgliteDir: true, removeWorkdir: true });
  process.exit(1);
}

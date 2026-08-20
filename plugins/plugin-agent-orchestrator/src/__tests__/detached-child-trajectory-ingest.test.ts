/**
 * Regression for top-level TASKS spawn_agent: its child starts before the
 * durable task id exists, so its pending trajectory directory must be ingested
 * from attached session metadata and surfaced as verifier-visible tool proof.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCompletionEvidenceString } from "../services/completion-evidence.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

let stateDir: string;
let priorStateDir: string | undefined;
let priorTrajectoryLogging: string | undefined;

beforeEach(() => {
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "detached-trace-")));
  priorStateDir = process.env.ELIZA_STATE_DIR;
  priorTrajectoryLogging = process.env.ELIZA_TRAJECTORY_LOGGING;
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_TRAJECTORY_LOGGING = "1";
});

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = priorStateDir;
  if (priorTrajectoryLogging === undefined) {
    delete process.env.ELIZA_TRAJECTORY_LOGGING;
  } else {
    process.env.ELIZA_TRAJECTORY_LOGGING = priorTrajectoryLogging;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe("detached child trajectory ingestion", () => {
  it("attaches the pending trace and renders exact FILE/SHELL evidence", async () => {
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      character: { name: "Tester" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getSetting: (key: string) => process.env[key],
      getService: () => undefined,
      reportError: vi.fn(),
      useModel: vi.fn(async () => "{}"),
    } as unknown as IAgentRuntime;
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(runtime, { store });
    const detached = service.prepareDetachedChildTrace();
    const trajectoryDir = detached.env.ELIZA_TRAJECTORY_DIR;
    expect(trajectoryDir).toBeTruthy();

    const created = await store.createTask({
      title: "read and test",
      goal: "read src/a.ts and run bun test",
      acceptanceCriteria: [],
    });
    const taskId = created.task.id;
    const sessionId = "detached-session-1";
    const now = Date.now();
    await store.addSession({
      id: "session-row-1",
      taskId,
      sessionId,
      framework: "elizaos",
      label: "reader",
      originalTask: "read and test",
      workdir: stateDir,
      status: "completed",
      decisionCount: 0,
      autoResolvedCount: 0,
      registeredAt: now,
      lastActivityAt: now,
      idleCheckCount: 0,
      taskDelivered: true,
      lastSeenDecisionIndex: 0,
      spawnedAt: now,
      retryCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      usageState: "unavailable",
      traceId: detached.env.ELIZA_TRACE_ID,
      parentTrajectoryStepId: detached.env.ELIZA_PARENT_TRAJECTORY_STEP_ID,
      metadata: detached.metadata,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    const nested = join(trajectoryDir as string, "child-agent");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "tj-child-1.json"),
      JSON.stringify({
        stages: [
          {
            kind: "tool",
            tool: {
              name: "FILE",
              args: { action: "read", path: "/repo/src/a.ts" },
              result: { success: true, text: "source omitted" },
            },
          },
          {
            kind: "tool",
            tool: {
              name: "SHELL",
              args: {
                action: "run",
                cwd: "/repo",
                command: "bun test src/a.test.ts",
              },
              result: { success: true, text: "3 pass\n0 fail" },
            },
          },
        ],
      }),
      "utf8",
    );

    const internals = service as unknown as {
      ingestChildTrajectories(
        taskId: string,
        sessionId: string,
      ): Promise<string[]>;
      collectEvidenceBundle(
        taskId: string,
        sessionId: string,
        summary: string,
      ): Promise<{
        summary: string;
        verifiedUrls: string[];
        screenshots: string[];
        childToolTrace?: Array<{ tool: string }>;
      }>;
    };
    expect(await internals.ingestChildTrajectories(taskId, sessionId)).toEqual([
      "tj-child-1",
    ]);
    const doc = await store.getTask(taskId);
    expect(doc?.artifacts).toEqual([
      expect.objectContaining({
        sessionId,
        artifactType: "trajectory",
        path: join(nested, "tj-child-1.json"),
      }),
    ]);
    expect((await store.findSession(sessionId, taskId))?.session).toMatchObject(
      {
        traceId: detached.env.ELIZA_TRACE_ID,
        parentTrajectoryStepId: detached.env.ELIZA_PARENT_TRAJECTORY_STEP_ID,
        childTrajectoryIds: ["tj-child-1"],
      },
    );

    const evidence = await internals.collectEvidenceBundle(
      taskId,
      sessionId,
      "done",
    );
    expect(evidence.childToolTrace?.map((entry) => entry.tool)).toEqual([
      "FILE",
      "SHELL",
    ]);
    const rendered = buildCompletionEvidenceString(evidence);
    expect(rendered).toContain('#1 FILE args={"action":"read"');
    expect(rendered).toContain(
      '"cwd":"/repo","command":"bun test src/a.test.ts"',
    );
    expect(rendered).toContain("3 pass");
    expect(rendered).toContain("0 fail");
  });
});

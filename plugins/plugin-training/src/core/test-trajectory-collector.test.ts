import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTestTrajectories,
  TEST_TRAJECTORY_COLLECTION_SCHEMA,
} from "./test-trajectory-collector.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "test-trajectory-collector-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function testTrajectory(caseId: string) {
  return {
    caseId,
    scenarioId: "action-selection.message",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    durationMs: 1_000,
    roomId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    transcript: [
      { role: "user", text: "send David the update", timestamp: 1 },
      {
        role: "assistant",
        text: "I sent it.",
        actions: ["SEND_MESSAGE"],
        timestamp: 2,
      },
    ],
    agentTrajectory: {
      llmCalls: [
        {
          callId: "llm-1",
          timestamp: 2,
          latencyMs: 42,
          modelType: "TEXT_LARGE",
          prompt: "choose an action",
          response: "SEND_MESSAGE",
          purpose: "action_planner",
        },
      ],
      providerSnapshots: [],
    },
    actions: [
      {
        phase: "completed",
        actionName: "SEND_MESSAGE",
        actionStatus: "success",
        timestamp: 2,
      },
    ],
    events: [{ type: "RUN_ENDED", timestamp: 3, data: {} }],
    memoriesWritten: [],
    metadata: { pass: true },
  };
}

describe("test trajectory collector", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("copies app-core test trajectory records into a collection run folder", async () => {
    const root = await makeTempDir();
    const outputDir = join(root, "out");
    const sourceDir = join(root, "source", "cases");
    await writeJson(
      join(sourceDir, "message-route.json"),
      testTrajectory("message-route"),
    );
    await writeJson(join(sourceDir, "not-a-trajectory.json"), {
      schema: "other",
    });

    const result = await collectTestTrajectories({
      roots: [join(root, "source")],
      outputDir,
      generatedAt: "2026-01-02T03:04:05.000Z",
    });

    expect(result.outputDir).toBe(outputDir);
    expect(result.manifest.schema).toBe(TEST_TRAJECTORY_COLLECTION_SCHEMA);
    expect(result.manifest.copiedCount).toBe(1);
    expect(result.manifest.skippedCount).toBe(1);
    expect(result.manifest.copied[0]).toMatchObject({
      caseId: "message-route",
      scenarioId: "action-selection.message",
      llmCalls: 1,
      actions: 1,
      transcriptTurns: 2,
    });
    const copied = JSON.parse(
      await readFile(result.manifest.copied[0].outputPath, "utf8"),
    );
    expect(copied.caseId).toBe("message-route");
    const manifestOnDisk = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    );
    expect(manifestOnDisk.copiedCount).toBe(1);
  });

  it("can create a dry-run test trajectory when no app-core output roots exist", async () => {
    const root = await makeTempDir();
    const outputDir = join(root, "out");

    const result = await collectTestTrajectories({
      roots: [],
      outputDir,
      generatedAt: "2026-01-02T03:04:05.000Z",
      syntheticFallback: true,
    });

    expect(result.manifest.roots).toEqual([]);
    expect(result.manifest.copiedCount).toBe(1);
    expect(result.manifest.syntheticCount).toBe(1);
    expect(result.manifest.copied[0]).toMatchObject({
      caseId: "dry-run-action-planner",
      scenarioId: "training_collection.synthetic_test",
      llmCalls: 1,
      actions: 1,
      transcriptTurns: 2,
    });
    const copied = JSON.parse(
      await readFile(result.manifest.copied[0].outputPath, "utf8"),
    );
    expect(copied.metadata).toMatchObject({
      dryRun: true,
      synthetic: true,
    });
  });
});

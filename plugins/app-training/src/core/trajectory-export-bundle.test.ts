import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
  TRAJECTORY_EXPORT_BUNDLE_VERSION,
  buildTrajectoryExportBundle,
} from "./trajectory-export-bundle.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trajectory-export-bundle-"));
  tempDirs.push(dir);
  return dir;
}

function baseTrajectory(): Trajectory {
  return {
    trajectoryId: "traj-1",
    agentId: "agent-1",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_000,
    durationMs: 1_000,
    steps: [
      {
        stepId: "step-1",
        timestamp: 1_700_000_000_100,
        llmCalls: [
          {
            callId: "call-1",
            purpose: "response",
            systemPrompt: "Reply directly.",
            userPrompt:
              "my key is sk-1234567890abcdef and coords are 37.7749, -122.4194",
            response: "I cannot help with exposed credentials.",
          },
        ],
      },
    ],
    metrics: { finalStatus: "completed" },
    metadata: { source: "test" },
  };
}

describe("trajectory export bundle", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes a sanitized bundle manifest without raw JSONL by default", async () => {
    const outputDir = await makeTempDir();

    const bundle = await buildTrajectoryExportBundle({
      outputDir,
      trajectories: [baseTrajectory()],
      tasks: ["response"],
      source: {
        kind: "test",
        metadata: { z: 1, a: 2 },
      },
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(bundle.manifest).toMatchObject({
      schema: TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
      schemaVersion: TRAJECTORY_EXPORT_BUNDLE_VERSION,
      generatedAt: "2026-01-02T03:04:05.000Z",
      source: {
        kind: "test",
        inputTrajectoryCount: 1,
        sanitizedTrajectoryCount: 1,
        droppedTrajectoryCount: 0,
        metadata: { a: 2, z: 1 },
      },
      counts: {
        rawTrajectoryRows: 0,
        sanitizedTrajectoryRows: 1,
        taskFiles: 1,
        taskExamples: 1,
      },
      cloudUpload: {
        uploadedToHuggingFace: false,
        includedInFirstDataset: false,
      },
    });
    expect(bundle.manifest.paths.rawJsonlPath).toBeUndefined();
    expect(bundle.manifest.paths.sanitizedJsonlPath).toBeTruthy();
    expect(bundle.manifest.privacy.applied).toBe(true);
    expect(bundle.manifest.privacy.redactionCount).toBeGreaterThanOrEqual(2);
    expect(bundle.manifest.tasks.response).toMatchObject({
      exampleCount: 1,
      sourceCallCount: 1,
      sourceTrajectoryCount: 1,
    });

    const manifestOnDisk = JSON.parse(
      await readFile(bundle.manifestPath, "utf8"),
    ) as typeof bundle.manifest;
    expect(manifestOnDisk.schema).toBe(TRAJECTORY_EXPORT_BUNDLE_SCHEMA);
    expect(manifestOnDisk.paths.rawJsonlPath).toBeUndefined();

    const sanitized = await readFile(
      bundle.manifest.paths.sanitizedJsonlPath!,
      "utf8",
    );
    expect(sanitized).not.toContain("sk-1234567890abcdef");
    expect(sanitized).not.toContain("37.7749, -122.4194");
    expect(sanitized).toContain("<REDACTED:openai-key>");
    expect(sanitized).toContain("[REDACTED_GEO]");
  });

  it("writes raw JSONL only when explicitly requested", async () => {
    const outputDir = await makeTempDir();

    const bundle = await buildTrajectoryExportBundle({
      outputDir,
      trajectories: [baseTrajectory()],
      includeRawJsonl: true,
      tasks: ["response"],
    });

    expect(bundle.manifest.paths.rawJsonlPath).toBeTruthy();
    const raw = await readFile(bundle.manifest.paths.rawJsonlPath!, "utf8");
    const sanitized = await readFile(
      bundle.manifest.paths.sanitizedJsonlPath!,
      "utf8",
    );

    expect(raw).toContain("sk-1234567890abcdef");
    expect(sanitized).not.toContain("sk-1234567890abcdef");
    expect(bundle.manifest.counts.rawTrajectoryRows).toBe(1);
  });
});

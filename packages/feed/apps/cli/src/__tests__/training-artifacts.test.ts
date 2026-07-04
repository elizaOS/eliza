/**
 * Tests for the training-artifact manifest writers, exercising real filesystem
 * writes into temp dirs and asserting the emitted schema/version/tag fields.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FEED_PARALLEL_GENERATION_SCHEMA,
  FEED_TRAJECTORY_EXPORT_SCHEMA,
  writeFeedParallelGenerationManifest,
  writeFeedTrajectoryExportManifest,
} from "../lib/training-artifacts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feed-training-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

describe("feed training artifact manifests", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("writes archetype trajectory export manifests next to JSONL", async () => {
    const dir = await makeTempDir();
    const exportPath = join(dir, "trajectories.jsonl");
    const manifest = await writeFeedTrajectoryExportManifest({
      exportPath,
      archetype: "trader",
      trajectoryCount: 2,
      scenarioIds: ["feed-sim", "feed-sim"],
      agentIds: ["agent-b", "agent-a"],
      generatedAt: "2026-01-02T03:04:05.000Z",
    });

    expect(manifest.schema).toBe(FEED_TRAJECTORY_EXPORT_SCHEMA);
    expect(manifest.manifestPath).toBe(join(dir, "trajectories.manifest.json"));
    expect(manifest.scenarioIds).toEqual(["feed-sim"]);
    expect(manifest.agentIds).toEqual(["agent-a", "agent-b"]);

    const onDisk = JSON.parse(await readFile(manifest.manifestPath, "utf8"));
    expect(onDisk.counts.trajectories).toBe(2);
  });

  test("writes parallel generation manifests with trajectory IDs", async () => {
    const dir = await makeTempDir();
    const manifest = await writeFeedParallelGenerationManifest({
      outputDir: dir,
      exportPath: join(dir, "feed-generated-trajectories.jsonl"),
      archetypes: ["trader", "degen", "trader"],
      agentsCreated: ["agent-1"],
      trajectoryIds: ["traj-1", "traj-2"],
      totalTicks: 6,
      durationMs: 1200,
      archetypeStats: {
        trader: { agents: 1, trajectories: 2, avgTicksPerAgent: 6 },
      },
      errors: [],
      cleanup: false,
      generatedAt: "2026-01-02T03:04:05.000Z",
    });

    expect(manifest.schema).toBe(FEED_PARALLEL_GENERATION_SCHEMA);
    expect(manifest.outputDir).toBe(dir);
    expect(manifest.exportPath).toBe(
      join(dir, "feed-generated-trajectories.jsonl"),
    );
    expect(manifest.source.archetypes).toEqual(["degen", "trader"]);
    expect(manifest.counts.trajectories).toBe(2);
    expect(manifest.manifestPath).toContain(
      "feed-parallel-2026-01-02T03-04-05",
    );

    const onDisk = JSON.parse(await readFile(manifest.manifestPath, "utf8"));
    expect(onDisk.outputDir).toBe(dir);
    expect(onDisk.exportPath).toBe(
      join(dir, "feed-generated-trajectories.jsonl"),
    );
    expect(onDisk.trajectoryIds).toEqual(["traj-1", "traj-2"]);
  });
});

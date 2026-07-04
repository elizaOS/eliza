/**
 * Covers the feed-generation runner's arg assembly and artifact recording with
 * a stub feed generator on a temp filesystem.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeedGenerationArgs,
  runFeedGeneration,
} from "./feed-generation-runner.js";

describe("feed generation runner", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.map((root) => rm(root, { recursive: true, force: true })),
    );
    tempRoots.length = 0;
  });

  it("builds a feed parallel generation command with conservative defaults", () => {
    const args = buildFeedGenerationArgs(
      { dryRun: true },
      { outputDir: "/tmp/training/feed/parallel/run-1" },
    );

    expect(args).toEqual([
      "run",
      "src/index.ts",
      "train",
      "parallel",
      "--archetypes",
      "trader",
      "--num-agents",
      "1",
      "--ticks",
      "1",
      "--parallel",
      "1",
      "--output-dir",
      "/tmp/training/feed/parallel/run-1",
      "--dry-run",
    ]);
  });

  it("passes generation scale, manager, cleanup, and output options", () => {
    const outputDir = join("/tmp", "feed-run");
    const args = buildFeedGenerationArgs(
      {
        archetypes: "trader,degen",
        numAgents: 3,
        ticks: 20,
        parallel: 2,
        managerId: "manager-1",
        cleanup: true,
      },
      { outputDir },
    );

    expect(args).toContain("trader,degen");
    expect(args).toContain("3");
    expect(args).toContain("20");
    expect(args).toContain("2");
    expect(args).toContain("--manager-id");
    expect(args).toContain("manager-1");
    expect(args).toContain("--cleanup");
    expect(args).not.toContain("--dry-run");
  });

  it("discovers feed manifest artifacts after generation completes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "feed-generation-runner-"));
    tempRoots.push(tempRoot);
    const outputDir = join(tempRoot, "feed-output");
    const fakeBun = join(tempRoot, "fake-bun.js");
    await writeFile(
      fakeBun,
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const outputDir = process.argv[process.argv.indexOf("--output-dir") + 1];
const nestedOutputDir = join(outputDir, "nested-feed-run");
mkdirSync(nestedOutputDir, { recursive: true });
const exportPath = join(nestedOutputDir, "feed-generated-trajectories.jsonl");
writeFileSync(exportPath, JSON.stringify({ id: "trajectory-1" }) + "\\n");
writeFileSync(
  join(nestedOutputDir, "feed-parallel.manifest.json"),
  JSON.stringify({
    schema: "feed_parallel_generation",
    generatedAt: "2026-01-02T03:04:05.000Z",
    outputDir: nestedOutputDir,
    exportPath,
    counts: { trajectories: 1 },
    source: { kind: "feed_train_parallel_generation", archetypes: ["trader"] }
  })
);
`,
    );
    await chmod(fakeBun, 0o755);

    const result = await runFeedGeneration({
      workspaceRoot: join(process.cwd(), "..", ".."),
      bun: fakeBun,
      outputDir,
      dryRun: false,
    });

    expect(result.command[0]).toBe(fakeBun);
    expect(result.outputDir).toBe(outputDir);
    expect(result.artifacts).toEqual([
      {
        schema: "feed_parallel_generation",
        manifestPath: join(
          outputDir,
          "nested-feed-run",
          "feed-parallel.manifest.json",
        ),
        exportPath: join(
          outputDir,
          "nested-feed-run",
          "feed-generated-trajectories.jsonl",
        ),
        outputDir: join(outputDir, "nested-feed-run"),
        sourceKind: "feed_train_parallel_generation",
        trajectories: 1,
        archetypes: ["trader"],
        generatedAt: "2026-01-02T03:04:05.000Z",
      },
    ]);
  });

  it("writes dry-run feed artifacts when the feed CLI only previews work", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "feed-generation-runner-"));
    tempRoots.push(tempRoot);
    const outputDir = join(tempRoot, "feed-output");
    const fakeBun = join(tempRoot, "fake-bun.js");
    await writeFile(
      fakeBun,
      `#!/usr/bin/env node
process.stdout.write("[DRY RUN] Would generate feed trajectories\\n");
`,
    );
    await chmod(fakeBun, 0o755);

    const result = await runFeedGeneration({
      workspaceRoot: join(process.cwd(), "..", ".."),
      bun: fakeBun,
      outputDir,
      archetypes: "trader,degen",
      numAgents: 1,
      ticks: 2,
      dryRun: true,
      cleanup: true,
    });

    expect(result.artifacts).toEqual([
      expect.objectContaining({
        schema: "feed_parallel_generation",
        manifestPath: join(outputDir, "feed-dry-run.manifest.json"),
        exportPath: join(outputDir, "feed-dry-run-trajectories.jsonl"),
        outputDir,
        sourceKind: "feed_train_parallel_generation",
        trajectories: 2,
        archetypes: ["trader", "degen"],
      }),
    ]);
    const exported = await readFile(
      join(outputDir, "feed-dry-run-trajectories.jsonl"),
      "utf8",
    );
    expect(exported).toContain("feed-dry-run-trader-1");
    expect(exported).toContain("DRY_RUN");
    expect(exported).toContain(
      "trader market observation for dry-run tick 1 of 2",
    );
    expect(exported).toContain("planned trader feed decision");
  });
});

/**
 * Covers the Eliza-1 bundle stager's manifest and subprocess-arg assembly and
 * its schema — deterministic, no shell-out.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEliza1BundleStageManifest,
  buildStageEliza1BundleArgs,
  ELIZA1_BUNDLE_STAGE_SCHEMA,
  parseStageEliza1BundlePlan,
} from "./eliza1-bundle-stager.js";

describe("Eliza-1 bundle stager", () => {
  it("builds a guarded plan-only staging command by default", () => {
    const trainingRoot = "/repo/packages/training";
    const args = buildStageEliza1BundleArgs(
      {
        tier: "2b",
        repoId: "elizaos/eliza-1",
        localDir: "/tmp/eliza-1-bundles",
        maxBytes: 2_000_000_000,
      },
      { trainingRoot },
    );

    expect(args).toEqual([
      join(trainingRoot, "scripts", "manifest", "stage_hf_eliza1_bundle.py"),
      "--tier",
      "2b",
      "--repo-id",
      "elizaos/eliza-1",
      "--local-dir",
      "/tmp/eliza-1-bundles",
      "--max-bytes",
      "2000000000",
    ]);
  });

  it("adds --apply only when explicitly requested", () => {
    expect(
      buildStageEliza1BundleArgs(
        { tier: "2b", apply: true },
        { trainingRoot: "/repo/packages/training" },
      ),
    ).toContain("--apply");
  });

  it("parses the JSON plan emitted by the Python stager", () => {
    expect(
      parseStageEliza1BundlePlan(
        JSON.stringify({
          repoId: "elizaos/eliza-1",
          tier: "2b",
          bundleDir: "/tmp/eliza-1-bundles/eliza-1-2b.bundle",
          plannedBytes: 123,
          apply: false,
        }),
      ),
    ).toMatchObject({
      repoId: "elizaos/eliza-1",
      tier: "2b",
      plannedBytes: 123,
      apply: false,
    });
    expect(parseStageEliza1BundlePlan("not json")).toBeNull();
  });

  it("builds an indexable stage manifest", () => {
    const manifest = buildEliza1BundleStageManifest({
      generatedAt: "2026-05-18T12:00:00.000Z",
      trainingRoot: "/repo/packages/training",
      outputDir: "/tmp/stage",
      manifestPath: "/tmp/stage/eliza1-bundle-stage-manifest.json",
      command: ["python3", "stage_hf_eliza1_bundle.py"],
      exitCode: 0,
      plan: {
        repoId: "elizaos/eliza-1",
        tier: "2b",
        bundleDir: "/tmp/eliza-1-bundles/eliza-1-2b.bundle",
        fileCount: 87,
        plannedBytes: 5_939_381_241,
        maxBytes: 8_589_934_592,
        apply: false,
        staged: [],
      },
    });

    expect(manifest).toMatchObject({
      schema: ELIZA1_BUNDLE_STAGE_SCHEMA,
      repoId: "elizaos/eliza-1",
      tier: "2b",
      fileCount: 87,
      plannedBytes: 5_939_381_241,
      stagedCount: 0,
    });
  });
});

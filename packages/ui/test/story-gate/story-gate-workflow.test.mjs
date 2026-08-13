import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = readFileSync(
  new URL("../../../../.github/workflows/ui-story-gate.yml", import.meta.url),
  "utf8",
);
const config = parse(workflow);
const shardJob = config.jobs["story-shard"];
const aggregateJob = config.jobs.aggregate;
const shardUpload = shardJob.steps.find((step) =>
  step.name?.startsWith("Upload shard report"),
);
const aggregateMerge = aggregateJob.steps.find((step) =>
  step.name?.startsWith("Merge and validate"),
);

describe("UI Story Gate workflow", () => {
  it("keeps develop runs queued instead of cancelling an active catalog", () => {
    expect(config.concurrency).toMatchObject({ "cancel-in-progress": false });
  });

  it("runs eight shards and uploads shard evidence", () => {
    expect(shardJob["timeout-minutes"]).toBe(35);
    expect(
      shardJob.steps.find((step) => step.name === "Run deterministic Story Gate shard"),
    ).toMatchObject({ "timeout-minutes": 20 });
    expect(shardJob.strategy).toMatchObject({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8] },
    });
    expect(shardUpload).toMatchObject({
      if: "${{ always() }}",
      with: {
        name: "story-gate-shard-${{ matrix.shard }}-of-8",
        path: "packages/ui/test/story-gate/output",
      },
    });
  });

  it("has an aggregate job that preserves fail-closed evidence", () => {
    expect(aggregateJob.needs).toEqual(["build-catalog", "story-shard"]);
    expect(aggregateJob.if).toBe("${{ always() }}");
    expect(aggregateMerge.if).toBe("${{ always() }}");
    expect(aggregateMerge.run).toContain("--shards 8");

    const catalogDownload = aggregateJob.steps.find(
      (step) => step.name === "Download static catalog",
    );
    const shardDownload = aggregateJob.steps.find(
      (step) => step.name === "Download all shard artifacts",
    );
    expect(catalogDownload).toMatchObject({ "continue-on-error": true });
    expect(shardDownload).toMatchObject({
      "continue-on-error": true,
      with: { pattern: "story-gate-shard-*-of-8", "merge-multiple": false },
    });
    expect(
      aggregateJob.steps.find(
        (step) => step.name === "Upload aggregate Story Gate output",
      ),
    ).toMatchObject({
      if: "${{ always() }}",
      with: { name: "story-gate-output" },
    });
  });
});

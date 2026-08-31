/**
 * Verifies the checked-in Story Gate workflow's shard matrix and fail-closed aggregation wiring.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const CANCELLATION_AWARE_EXPRESSION = "$" + "{{ always() && !cancelled() }}";
const PUSH_EVENT_EXPRESSION = "$" + "{{ github.event_name == 'push' }}";
const MATRIX_SHARD_EXPRESSION = "$" + "{{ matrix.shard }}";
const workflow = readFileSync(
  new URL("../../../../.github/workflows/ui-story-gate.yml", import.meta.url),
  "utf8",
);
const config = parse(workflow);
const buildCatalogJob = config.jobs["build-catalog"];
const shardJob = config.jobs["story-shard"];
const aggregateJob = config.jobs.aggregate;
const catalogUpload = buildCatalogJob.steps.find((step) =>
  step.name?.startsWith("Upload static Storybook"),
);
const shardUpload = shardJob.steps.find((step) =>
  step.name?.startsWith("Upload shard report"),
);
const aggregateMerge = aggregateJob.steps.find((step) =>
  step.name?.startsWith("Merge and validate"),
);

describe("UI Story Gate workflow", () => {
  it("cancels superseded push runs but preserves manual and called runs", () => {
    expect(config.concurrency).toMatchObject({
      "cancel-in-progress": PUSH_EVENT_EXPRESSION,
    });
  });

  it("runs eight shards and uploads shard evidence", () => {
    expect(catalogUpload.if).toBe(CANCELLATION_AWARE_EXPRESSION);
    expect(shardJob.if).toBe(CANCELLATION_AWARE_EXPRESSION);
    expect(shardJob["timeout-minutes"]).toBe(35);
    expect(
      shardJob.steps.find(
        (step) => step.name === "Run deterministic Story Gate shard",
      ),
    ).toMatchObject({ "timeout-minutes": 20 });
    expect(shardJob.strategy).toMatchObject({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8] },
    });
    expect(shardUpload).toMatchObject({
      if: CANCELLATION_AWARE_EXPRESSION,
      with: {
        name: `story-gate-shard-${MATRIX_SHARD_EXPRESSION}-of-8`,
        path: "packages/ui/test/story-gate/output",
      },
    });
  });

  it("has an aggregate job that preserves fail-closed evidence", () => {
    expect(aggregateJob.needs).toEqual(["build-catalog", "story-shard"]);
    expect(aggregateJob.if).toBe(CANCELLATION_AWARE_EXPRESSION);
    expect(aggregateMerge.if).toBe(CANCELLATION_AWARE_EXPRESSION);
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
      if: CANCELLATION_AWARE_EXPRESSION,
      with: { name: "story-gate-output" },
    });
  });
});

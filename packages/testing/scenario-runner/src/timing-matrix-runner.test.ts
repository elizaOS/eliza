/** Tests crash-safe shard adoption, resumption, retry, and exact merging. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runTimingMatrix,
  type TimingShardInvocation,
} from "./timing-matrix-runner.ts";
import {
  summarizeTimingPredictions,
  type TimingReport,
} from "./when2speak-eval.ts";

function writeReport(options: {
  invocation: TimingShardInvocation;
  input: string;
  status: TimingReport["status"];
}): void {
  const prediction = {
    row: options.invocation.shardIndex + 1,
    gold: "SPEAK" as const,
    predicted: "SPEAK" as const,
    textuallyReferencesAgent: false,
    directlyAddressesAgent: false,
    effectiveAddressed: false,
    addressSignals: {
      platformMention: false,
      replyToAgent: false,
      textualAgentName: false,
    },
    speakerCount: 2,
    contextTurns: 3,
  };
  const summary = summarizeTimingPredictions([prediction]);
  const report: TimingReport = {
    schema: 4,
    status: options.status,
    dataset: "duke-trust-lab/When2Speak",
    input: options.input,
    inputSha256: createHash("sha256")
      .update(fs.readFileSync(options.input))
      .digest("hex"),
    provider: "cli",
    requestedModel: "test-model",
    backend: "test-backend",
    characterPreset: "minimal",
    characterSha256: "test-character-sha256",
    runtimeProfile: "classifier-isolated",
    trajectoryDir: options.invocation.trajectoryDir,
    selection: {
      shardIndex: options.invocation.shardIndex,
      shardCount: options.invocation.shardCount,
      startRow: 1,
      limit: null,
    },
    startedAt: "2026-08-24T00:00:00.000Z",
    finishedAt: "2026-08-24T00:01:00.000Z",
    ...summary,
    predictions: [prediction],
    exclusions: [],
    failures: [],
  };
  fs.writeFileSync(options.invocation.report, JSON.stringify(report), "utf8");
}

function fixture(): { input: string; outputDir: string } {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "timing-matrix-runner-"),
  );
  const input = path.join(directory, "input.jsonl");
  fs.writeFileSync(input, "{}\n{}\n", "utf8");
  return { input, outputDir: path.join(directory, "output") };
}

describe("timing matrix runner", () => {
  it("resumes interrupted shards, merges exact coverage, and adopts reruns", async () => {
    const { input, outputDir } = fixture();
    const invocations: TimingShardInvocation[] = [];
    const first = await runTimingMatrix({
      input,
      inputFormat: "when2speak",
      provider: "cli",
      outputDir,
      shardCount: 2,
      workers: 2,
      maxAttempts: 3,
      retryDelayMs: 0,
      runShard: async (invocation) => {
        invocations.push(invocation);
        writeReport({
          invocation,
          input,
          status:
            invocation.shardIndex === 0 && invocation.attempt === 1
              ? "in-progress"
              : "complete",
        });
        return { kind: "exited", exitCode: invocation.attempt === 1 ? 1 : 0 };
      },
    });
    expect(first.manifest.status).toBe("complete");
    expect(first.matrix.cells[0]).toMatchObject({
      physicalRows: 2,
      acceptedRows: 2,
    });
    expect(
      invocations.filter(({ shardIndex }) => shardIndex === 0),
    ).toMatchObject([
      { attempt: 1, resume: false },
      { attempt: 2, resume: true },
    ]);

    let rerunCalls = 0;
    await runTimingMatrix({
      input,
      inputFormat: "when2speak",
      provider: "cli",
      outputDir,
      shardCount: 2,
      workers: 2,
      maxAttempts: 3,
      retryDelayMs: 0,
      runShard: async () => {
        rerunCalls += 1;
        return { kind: "exited", exitCode: 0 };
      },
    });
    expect(rerunCalls).toBe(0);
  });

  it("fails after a bounded retry budget without fabricating completion", async () => {
    const { input, outputDir } = fixture();
    await expect(
      runTimingMatrix({
        input,
        inputFormat: "when2speak",
        provider: "cli",
        outputDir,
        shardCount: 1,
        workers: 1,
        maxAttempts: 2,
        retryDelayMs: 0,
        runShard: async () => ({ kind: "exited", exitCode: 1 }),
      }),
    ).rejects.toThrow("exhausted its retry budget");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, "run-manifest.json"), "utf8"),
    ) as { status: string };
    expect(manifest.status).toBe("in-progress");
  });
});

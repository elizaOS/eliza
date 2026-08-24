/** Tests shard coverage and matrix aggregation against real temporary files. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeTimingReports } from "./timing-report-merge.ts";
import {
  summarizeTimingPredictions,
  type TimingPrediction,
  type TimingReport,
} from "./when2speak-eval.ts";

function writeShard(options: {
  directory: string;
  input: string;
  shardIndex: number;
  predictions: TimingPrediction[];
  failures?: TimingReport["failures"];
}): string {
  const summary = summarizeTimingPredictions(options.predictions);
  const report: TimingReport = {
    schema: 4,
    status: "complete",
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
    trajectoryDir: path.join(options.directory, "trajectories"),
    selection: {
      shardIndex: options.shardIndex,
      shardCount: 2,
      startRow: 1,
      limit: null,
    },
    startedAt: "2026-08-24T00:00:00.000Z",
    finishedAt: "2026-08-24T00:01:00.000Z",
    ...summary,
    predictions: options.predictions,
    exclusions: [],
    failures: options.failures ?? [],
  };
  const file = path.join(options.directory, `shard-${options.shardIndex}.json`);
  fs.writeFileSync(file, JSON.stringify(report), "utf8");
  return file;
}

describe("timing report merger", () => {
  it("proves complete non-overlapping shard coverage", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "timing-merge-"));
    const input = path.join(directory, "input.jsonl");
    fs.writeFileSync(input, "{}\n{}\n", "utf8");
    const first = writeShard({
      directory,
      input,
      shardIndex: 0,
      predictions: [
        {
          row: 1,
          gold: "SPEAK",
          predicted: "SPEAK",
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
        },
      ],
    });
    const second = writeShard({
      directory,
      input,
      shardIndex: 1,
      predictions: [
        {
          row: 2,
          gold: "SILENT",
          predicted: "SILENT",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: true,
          effectiveAddressed: true,
          addressSignals: {
            platformMention: true,
            replyToAgent: false,
            textualAgentName: false,
          },
          speakerCount: 3,
          contextTurns: 6,
        },
      ],
    });
    const matrix = mergeTimingReports([second, first]);
    expect(matrix.cells).toHaveLength(1);
    expect(matrix.cells[0]).toMatchObject({
      physicalRows: 2,
      acceptedRows: 2,
      excludedRows: 0,
      malformedRows: 0,
      rejectedRows: 0,
      metrics: { total: 2, correct: 2, accuracy: 1 },
      objectives: {
        labelAgreement: { total: 2, correct: 2, accuracy: 1 },
        ambientRestraint: {
          eligibleTurns: 1,
          predictedResponses: 1,
          predictedSilences: 0,
          responseRate: 1,
          restraintRate: 0,
        },
      },
    });
  });

  it("rejects a matrix with a missing shard", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "timing-merge-"));
    const input = path.join(directory, "input.jsonl");
    fs.writeFileSync(input, "{}\n{}\n", "utf8");
    const first = writeShard({
      directory,
      input,
      shardIndex: 0,
      predictions: [
        {
          row: 1,
          gold: "SPEAK",
          predicted: "SILENT",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: false,
          speakerCount: 2,
          contextTurns: 3,
        },
      ],
    });
    expect(() => mergeTimingReports([first])).toThrow(
      "missing required shards",
    );
  });

  it("rejects equal-cardinality coverage with an out-of-range row", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "timing-merge-"));
    const input = path.join(directory, "input.jsonl");
    fs.writeFileSync(input, "{}\n{}\n", "utf8");
    const first = writeShard({
      directory,
      input,
      shardIndex: 0,
      predictions: [
        {
          row: 1,
          gold: "SPEAK",
          predicted: "SPEAK",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: false,
          speakerCount: 2,
          contextTurns: 3,
        },
      ],
    });
    const second = writeShard({
      directory,
      input,
      shardIndex: 1,
      predictions: [
        {
          row: 4,
          gold: "SILENT",
          predicted: "SILENT",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: true,
          speakerCount: 3,
          contextTurns: 6,
        },
      ],
    });
    expect(() => mergeTimingReports([first, second])).toThrow(
      "does not cover every physical input row",
    );
  });

  it("rejects rows assigned to the wrong shard", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "timing-merge-"));
    const input = path.join(directory, "input.jsonl");
    fs.writeFileSync(input, "{}\n{}\n", "utf8");
    const first = writeShard({
      directory,
      input,
      shardIndex: 0,
      predictions: [
        {
          row: 2,
          gold: "SPEAK",
          predicted: "SPEAK",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: false,
          speakerCount: 2,
          contextTurns: 3,
        },
      ],
    });
    const second = writeShard({
      directory,
      input,
      shardIndex: 1,
      predictions: [
        {
          row: 1,
          gold: "SILENT",
          predicted: "SILENT",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: true,
          speakerCount: 3,
          contextTurns: 6,
        },
      ],
    });
    expect(() => mergeTimingReports([first, second])).toThrow(
      "does not belong to its reported shard",
    );
  });

  it("rejects reports after the source changes at the same path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "timing-merge-"));
    const input = path.join(directory, "input.jsonl");
    fs.writeFileSync(input, "{}\n{}\n", "utf8");
    const first = writeShard({
      directory,
      input,
      shardIndex: 0,
      predictions: [
        {
          row: 1,
          gold: "SPEAK",
          predicted: "SPEAK",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: false,
          speakerCount: 2,
          contextTurns: 3,
        },
      ],
    });
    const second = writeShard({
      directory,
      input,
      shardIndex: 1,
      predictions: [
        {
          row: 2,
          gold: "SILENT",
          predicted: "SILENT",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: true,
          speakerCount: 3,
          contextTurns: 6,
        },
      ],
    });
    fs.writeFileSync(input, '{"changed":true}\n{}\n', "utf8");
    expect(() => mergeTimingReports([first, second])).toThrow(
      "input content does not match",
    );
  });

  it("counts an internal blank line as a malformed physical row", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "timing-merge-"));
    const input = path.join(directory, "input.jsonl");
    fs.writeFileSync(input, "{}\n\n{}\n", "utf8");
    const first = writeShard({
      directory,
      input,
      shardIndex: 0,
      predictions: [
        {
          row: 1,
          gold: "SPEAK",
          predicted: "SPEAK",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: false,
          speakerCount: 2,
          contextTurns: 3,
        },
        {
          row: 3,
          gold: "SILENT",
          predicted: "SILENT",
          textuallyReferencesAgent: false,
          directlyAddressesAgent: false,
          speakerCount: 2,
          contextTurns: 3,
        },
      ],
    });
    const second = writeShard({
      directory,
      input,
      shardIndex: 1,
      predictions: [],
      failures: [{ row: 2, error: "blank row" }],
    });
    expect(mergeTimingReports([first, second]).cells[0]).toMatchObject({
      physicalRows: 3,
      acceptedRows: 2,
      malformedRows: 1,
    });
  });
});

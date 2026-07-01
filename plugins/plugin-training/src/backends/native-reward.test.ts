/**
 * Reward-weighting in the native backend dataset loader (#8795).
 *
 * The JSONL loader must (a) drop rows whose `scenario_status` marks the
 * source scenario failed/skipped — never optimize toward a failure — and
 * (b) carry the numeric judge score / pass status into
 * `OptimizationExample.reward` so bootstrap-fewshot's reward-first ranking
 * actually has a quality signal to rank on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmAdapter } from "../optimizers/types.js";
import { runNativeBackend } from "./native.js";

const echoAdapter: LlmAdapter = {
  async complete() {
    return '{"title":"stub"}';
  },
};

function nativeRow(
  id: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    format: "eliza_native_v1",
    schemaVersion: 1,
    boundary: "vercel_ai_sdk.generateText",
    request: {
      messages: [
        { role: "system", content: "Extract the event." },
        { role: "user", content: `schedule ${id}` },
      ],
    },
    response: { text: `{"title":"${id}"}` },
    metadata,
  };
}

describe("native backend reward weighting", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "native-reward-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDataset(rows: Record<string, unknown>[]): string {
    const datasetPath = join(dir, "dataset.jsonl");
    writeFileSync(
      datasetPath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf-8",
    );
    return datasetPath;
  }

  it("excludes failed/skipped-scenario rows from the parsed dataset", async () => {
    const datasetPath = writeDataset([
      nativeRow("failed", { scenario_status: "failed" }),
      nativeRow("skipped", { scenario_status: "skipped" }),
      nativeRow("passed", { scenario_status: "passed" }),
    ]);
    const result = await runNativeBackend({
      datasetPath,
      task: "calendar_extract",
      optimizer: "bootstrap-fewshot",
      baselinePrompt: "Extract the event.",
      runtime: { useModel: async () => "stub" },
      adapter: echoAdapter,
      holdoutFraction: 0,
    });
    expect(result.datasetSize).toBe(1);
    expect(result.dataset.map((ex) => ex.input.user)).toEqual([
      "schedule passed",
    ]);
    expect(
      result.notes.some((note) =>
        note.includes("excluded 2 failed/skipped-scenario row(s)"),
      ),
    ).toBe(true);
  });

  it("returns invoked=false with the exclusion note when every row failed", async () => {
    const datasetPath = writeDataset([
      nativeRow("failed-a", { scenario_status: "failed" }),
      nativeRow("failed-b", { scenario_status: "failed" }),
    ]);
    const result = await runNativeBackend({
      datasetPath,
      task: "calendar_extract",
      optimizer: "bootstrap-fewshot",
      baselinePrompt: "Extract the event.",
      runtime: { useModel: async () => "stub" },
      adapter: echoAdapter,
      holdoutFraction: 0,
    });
    expect(result.invoked).toBe(false);
    expect(result.datasetSize).toBe(0);
    expect(
      result.notes.some((note) =>
        note.includes("excluded 2 failed/skipped-scenario row(s)"),
      ),
    ).toBe(true);
  });

  it("populates reward from judge_score / pass status", async () => {
    const datasetPath = writeDataset([
      nativeRow("judged", { scenario_status: "passed", judge_score: 0.6 }),
      nativeRow("passed", { scenario_status: "passed" }),
      nativeRow("unknown", {}),
    ]);
    const result = await runNativeBackend({
      datasetPath,
      task: "calendar_extract",
      optimizer: "bootstrap-fewshot",
      baselinePrompt: "Extract the event.",
      runtime: { useModel: async () => "stub" },
      adapter: echoAdapter,
      holdoutFraction: 0,
    });
    const byUser = new Map(
      result.dataset.map((ex) => [ex.input.user, ex.reward] as const),
    );
    expect(byUser.get("schedule judged")).toBe(0.6);
    expect(byUser.get("schedule passed")).toBe(1);
    expect(byUser.get("schedule unknown")).toBeUndefined();
  });

  it("ranks bootstrap-fewshot demonstrations reward-first", async () => {
    const datasetPath = writeDataset([
      nativeRow("low", { scenario_status: "passed", judge_score: 0.5 }),
      nativeRow("high", { scenario_status: "passed", judge_score: 0.9 }),
    ]);
    const result = await runNativeBackend({
      datasetPath,
      task: "calendar_extract",
      optimizer: "bootstrap-fewshot",
      baselinePrompt: "Extract the event.",
      runtime: { useModel: async () => "stub" },
      adapter: echoAdapter,
      holdoutFraction: 0,
    });
    expect(result.invoked).toBe(true);
    const demos = result.result.fewShotExamples ?? [];
    expect(demos[0]?.reward).toBe(0.9);
    expect(demos[1]?.reward).toBe(0.5);
  });
});

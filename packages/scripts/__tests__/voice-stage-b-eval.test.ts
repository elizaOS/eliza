// Exercises tests voice stage b eval.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  STAGE_B_SCHEMA,
  validateStageBReport,
} from "../lib/voice-stage-b-eval.mjs";

async function makeArtifact(root: string, backend: string, name: string) {
  const artifactPath = path.join(root, "artifacts", backend, name);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, `${backend} ${name}\n`);
  return path.relative(root, artifactPath);
}

async function validRun(root: string, overrides: Record<string, unknown> = {}) {
  const backend = String(overrides.backend);
  const platform = String(overrides.platform);
  return {
    backend,
    platform,
    realHardware: true,
    device: { name: `${platform} device`, osVersion: "test-os-1" },
    build: { gitSha: "0123456789abcdef" },
    audio: { source: "speaker-to-mic", durationSeconds: 90 },
    metrics: {
      utterances: 12,
      trueAccepts: 11,
      falseAccepts: 0,
      acceptRate: 0.92,
      wordErrorRate: 0.12,
      msPerFrame: 7.5,
      latencyMs: { p50: 420, p95: 980, max: 1200 },
    },
    battery:
      platform === "ios" || platform === "android"
        ? { startPercent: 91, endPercent: 89, durationMinutes: 12 }
        : undefined,
    power:
      platform === "linux"
        ? { avgPowerWatts: 11.4, durationMinutes: 12 }
        : undefined,
    artifacts: [
      {
        kind: "log",
        path: await makeArtifact(root, backend, "run.log"),
        reviewed: true,
      },
      {
        kind: "matrix",
        path: await makeArtifact(root, backend, "metrics.json"),
        reviewed: true,
      },
    ],
    ...overrides,
  };
}

async function validReport(root: string) {
  return {
    schema: STAGE_B_SCHEMA,
    issue: 9958,
    capturedAt: "2026-06-30T04:00:00.000Z",
    realHardware: true,
    build: { gitSha: "0123456789abcdef" },
    runs: [
      await validRun(root, {
        backend: "ios-sfspeechrecognizer",
        platform: "ios",
      }),
      await validRun(root, {
        backend: "android-speechrecognizer",
        platform: "android",
      }),
      await validRun(root, { backend: "fused-asr", platform: "linux" }),
    ],
  };
}

describe("voice Stage-B evaluation validator", () => {
  test("accepts a reviewed real three-backend report", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-b-ok-"));
    const report = await validReport(root);
    const result = validateStageBReport(report, {
      reportPath: path.join(root, "report.json"),
      repoRoot: root,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.checkedBackends).toEqual([
      "ios-sfspeechrecognizer",
      "android-speechrecognizer",
      "fused-asr",
    ]);
  });

  test("rejects mock reports and missing required backends", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-b-mock-"));
    const report = await validReport(root);
    report.mocked = true;
    report.runs = report.runs.filter(
      (run) => run.backend !== "android-speechrecognizer",
    );

    const result = validateStageBReport(report, {
      reportPath: path.join(root, "report.json"),
      repoRoot: root,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "report must not be marked mocked/synthetic",
    );
    expect(result.errors).toContain(
      "missing required Stage-B backend android-speechrecognizer (Android SpeechRecognizer)",
    );
  });

  test("rejects unreviewed artifacts and weak metrics", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-b-bad-"));
    const report = await validReport(root);
    const iosRun = report.runs[0];
    iosRun.metrics.wordErrorRate = 0.8;
    iosRun.metrics.utterances = 1;
    iosRun.artifacts[0].reviewed = false;

    const result = validateStageBReport(report, {
      reportPath: path.join(root, "report.json"),
      repoRoot: root,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "runs[0] ios-sfspeechrecognizer.metrics.utterances must be at least 10",
    );
    expect(result.errors).toContain(
      "runs[0] ios-sfspeechrecognizer.metrics.wordErrorRate must be between 0 and 0.35",
    );
    expect(result.errors).toContain(
      "runs[0] ios-sfspeechrecognizer.artifacts[0].reviewed must be true after manual review",
    );
  });
});

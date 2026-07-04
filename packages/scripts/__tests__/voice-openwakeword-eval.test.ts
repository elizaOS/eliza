// Exercises tests voice openwakeword eval.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OPENWAKEWORD_SCHEMA,
  validateOpenWakeWordReport,
} from "../lib/voice-openwakeword-eval.mjs";

async function makeArtifact(root: string, caseId: string, name: string) {
  const artifactPath = path.join(root, "artifacts", caseId, name);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, `${caseId} ${name}\n`);
  return path.relative(root, artifactPath);
}

async function validRun(
  root: string,
  caseId: string,
  observations: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    case: caseId,
    platform: "android",
    realHardware: true,
    realHead: true,
    device: { name: "Pixel voice device", osVersion: "Android test" },
    build: { gitSha: "0123456789abcdef" },
    openWakeWord: { model: "hey-eliza", threshold: 0.62 },
    audio: { source: "speaker-to-mic", durationSeconds: 45 },
    observations,
    artifacts: [
      {
        kind: "log",
        path: await makeArtifact(root, caseId, "run.log"),
        reviewed: true,
      },
      {
        kind: "recording",
        path: await makeArtifact(root, caseId, "screen-audio.txt"),
        reviewed: true,
      },
    ],
    ...overrides,
  };
}

async function validReport(root: string) {
  return {
    schema: OPENWAKEWORD_SCHEMA,
    issue: 9958,
    capturedAt: "2026-06-30T05:00:00.000Z",
    realHardware: true,
    realHead: true,
    build: { gitSha: "0123456789abcdef" },
    runs: [
      await validRun(root, "idle-wake", {
        wakeEvents: 1,
        listenWindowOpened: true,
        latencyMs: 320,
      }),
      await validRun(root, "already-listening-wake-inert", {
        wakeEvents: 1,
        listenWindowOpened: false,
        duplicateWindowCount: 0,
      }),
      await validRun(root, "mid-transcription-wake", {
        wakeEvents: 1,
        transcriptCorrupted: false,
        droppedTokens: 0,
      }),
    ],
  };
}

describe("voice openWakeWord real-head validator", () => {
  test("accepts a reviewed real three-case report", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openwakeword-ok-"));
    const report = await validReport(root);
    const result = validateOpenWakeWordReport(report, {
      reportPath: path.join(root, "report.json"),
      repoRoot: root,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.checkedCases).toEqual([
      "idle-wake",
      "already-listening-wake-inert",
      "mid-transcription-wake",
    ]);
  });

  test("rejects mock reports and missing wake-context cases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openwakeword-mock-"));
    const report = await validReport(root);
    report.mocked = true;
    report.runs = report.runs.filter((run) => run.case !== "idle-wake");

    const result = validateOpenWakeWordReport(report, {
      reportPath: path.join(root, "report.json"),
      repoRoot: root,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "report must not be marked mocked/synthetic",
    );
    expect(result.errors).toContain(
      "missing required openWakeWord case idle-wake (idle wake opens the listen window)",
    );
  });

  test("rejects unreviewed artifacts and contradictory observations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openwakeword-bad-"));
    const report = await validReport(root);
    const inertRun = report.runs[1];
    inertRun.observations.listenWindowOpened = true;
    inertRun.observations.duplicateWindowCount = 1;
    inertRun.artifacts[0].reviewed = false;

    const result = validateOpenWakeWordReport(report, {
      reportPath: path.join(root, "report.json"),
      repoRoot: root,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "runs[1] already-listening-wake-inert.observations.listenWindowOpened must be false",
    );
    expect(result.errors).toContain(
      "runs[1] already-listening-wake-inert.observations.duplicateWindowCount must be 0",
    );
    expect(result.errors).toContain(
      "runs[1] already-listening-wake-inert.artifacts[0].reviewed must be true after manual review",
    );
  });
});

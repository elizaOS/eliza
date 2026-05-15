/**
 * verify-run.ts — assertion harness for a completed three-agent dialogue run.
 *
 * Can be used:
 *   1. As a library by the smoke test (import `verifyRun`).
 *   2. As a CLI: `bun run verify/verify-run.ts --dir=<output-dir>`.
 *
 * Reads the JSON artefacts written by run-dialogue.ts and asserts the
 * verification thresholds from the scenario. Emits a structured report.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  estimateWavDurationSec,
  isAudioNonBlank,
} from "../runner/audio-bus.ts";
import type {
  EmotionEntry,
  TranscriptEntry,
  VerificationResult,
} from "../runner/run-dialogue.ts";

export interface RunVerificationReport {
  runDir: string;
  verification: VerificationResult;
  transcriptCount: number;
  emotionEntries: number;
  turnEventCount: number;
  mixWavExists: boolean;
  mixWavDurationSec: number;
  mixWavNonBlank: boolean;
  pass: boolean;
}

/**
 * Verify a completed dialogue run by reading artefacts from `runDir`.
 * Throws if required files are missing.
 */
export function verifyRun(runDir: string): RunVerificationReport {
  const requiredFiles = [
    "transcripts.json",
    "emotion.json",
    "turn-events.json",
    "verification.json",
    "mix.wav",
  ];

  for (const file of requiredFiles) {
    const path = join(runDir, file);
    if (!existsSync(path)) {
      throw new Error(`Required artefact missing: ${path}`);
    }
  }

  const transcripts = JSON.parse(
    readFileSync(join(runDir, "transcripts.json"), "utf-8"),
  ) as TranscriptEntry[];

  const emotions = JSON.parse(
    readFileSync(join(runDir, "emotion.json"), "utf-8"),
  ) as EmotionEntry[];

  const turnEvents = JSON.parse(
    readFileSync(join(runDir, "turn-events.json"), "utf-8"),
  ) as unknown[];

  const verification = JSON.parse(
    readFileSync(join(runDir, "verification.json"), "utf-8"),
  ) as VerificationResult;

  const mixPath = join(runDir, "mix.wav");
  const mixBytes = new Uint8Array(readFileSync(mixPath));
  const mixDuration = estimateWavDurationSec(mixBytes);
  const mixNonBlank = isAudioNonBlank(mixBytes);

  return {
    runDir,
    verification,
    transcriptCount: transcripts.length,
    emotionEntries: emotions.length,
    turnEventCount: turnEvents.length,
    mixWavExists: true,
    mixWavDurationSec: Math.round(mixDuration * 100) / 100,
    mixWavNonBlank: mixNonBlank,
    pass: verification.pass && mixNonBlank,
  };
}

/**
 * Assert that a run report passes all required checks.
 * Throws with a descriptive message if any check fails.
 */
export function assertRunPasses(report: RunVerificationReport): void {
  const checks: Array<{ label: string; pass: boolean }> = [
    { label: "verification.pass", pass: report.verification.pass },
    { label: "mix.wav exists", pass: report.mixWavExists },
    { label: "mix.wav non-blank", pass: report.mixWavNonBlank },
    { label: "mix.wav duration ≥ 1s", pass: report.mixWavDurationSec >= 1.0 },
    {
      label: "transcripts not null",
      pass: report.verification.transcriptNotNull,
    },
    {
      label: "distinct speakers ≥ 3",
      pass: report.verification.distinctSpeakersDetected >= 3,
    },
    {
      label: "emotion fraction ≥ 80%",
      pass: report.verification.emotionDetectedFraction >= 0.8,
    },
  ];

  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    const msg = failed.map((c) => `  ✗ ${c.label}`).join("\n");
    throw new Error(`Run verification failed:\n${msg}`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const dirArg = parseArg("dir");
  if (!dirArg) {
    console.error("Usage: bun run verify/verify-run.ts --dir=<output-dir>");
    process.exit(1);
  }

  const report = verifyRun(dirArg);

  console.log("\n[verify-run] === VERIFICATION REPORT ===");
  console.log(`  Run dir:              ${report.runDir}`);
  console.log(`  Transcripts:          ${report.transcriptCount}`);
  console.log(`  Emotion entries:      ${report.emotionEntries}`);
  console.log(`  Turn events:          ${report.turnEventCount}`);
  console.log(`  mix.wav exists:       ${report.mixWavExists}`);
  console.log(`  mix.wav duration:     ${report.mixWavDurationSec}s`);
  console.log(`  mix.wav non-blank:    ${report.mixWavNonBlank}`);
  console.log(
    `  Distinct speakers:    ${report.verification.distinctSpeakersDetected}`,
  );
  console.log(
    `  Emotion fraction:     ${(report.verification.emotionDetectedFraction * 100).toFixed(0)}%`,
  );
  console.log(`  PASS:                 ${report.pass}`);

  if (!report.pass) {
    console.error("\n[verify-run] FAILED");
    process.exit(1);
  } else {
    console.log("\n[verify-run] PASSED");
  }
}

// Only run CLI when invoked directly, not when imported as a module.
if (
  typeof import.meta !== "undefined" &&
  // Bun sets import.meta.main = true on the entry module
  ((import.meta as { main?: boolean }).main === true ||
    // Node fallback: check process.argv[1]
    (typeof process !== "undefined" &&
      process.argv[1] &&
      import.meta.url &&
      import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))))
) {
  main().catch((err) => {
    console.error("[verify-run] Fatal:", err);
    process.exit(1);
  });
}

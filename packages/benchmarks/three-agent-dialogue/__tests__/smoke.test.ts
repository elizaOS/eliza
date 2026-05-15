/**
 * smoke.test.ts — CI smoke test for the three-agent dialogue harness.
 *
 * Runs the first 4 turns of the canonical scenario (~30s).
 * Skips the full audio-production path when GROQ_API_KEY is absent
 * (unit mode) to keep CI green without credentials, but still validates
 * the harness infrastructure (artefact structure, bus logic, verification JSON).
 *
 * With GROQ_API_KEY set this test runs real TTS + ASR and validates
 * non-blank audio and non-null transcripts end-to-end.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(PKG_DIR, "../../..");

// We import the runner for unit-mode testing of the bus / verification logic.
// The real runtime is only exercised when GROQ_API_KEY is set.
import {
  AudioBus,
  estimateWavDurationSec,
  isAudioNonBlank,
} from "../runner/audio-bus.ts";
import { verifyRun } from "../verify/verify-run.ts";

// ---------------------------------------------------------------------------
// AudioBus unit tests (always run — no API key needed)
// ---------------------------------------------------------------------------

describe("AudioBus", () => {
  it("produces a non-empty mix WAV from silent PCM input", () => {
    const bus = new AudioBus();
    // 0.5s of silence at 16-bit / 22050Hz / mono
    const silentPcm = new Uint8Array(Math.round(22050 * 0.5) * 2);
    bus.publish(0, "alice", silentPcm);
    bus.publish(1, "bob", silentPcm);

    const stats = bus.stats();
    expect(stats.totalChunks).toBe(2);
    expect(stats.speakerChunks.alice).toBe(1);
    expect(stats.speakerChunks.bob).toBe(1);
    expect(stats.durationEstimateSec).toBeGreaterThan(0);
  });

  it("flush writes turn files and mix.wav to a temp dir", async () => {
    const tmpDir = join(
      REPO_ROOT,
      "artifacts",
      "three-agent-dialogue",
      "_smoke-bus-test",
    );
    mkdirSync(tmpDir, { recursive: true });

    try {
      const bus = new AudioBus();
      const pcm = new Uint8Array(22050 * 2); // 1s silence
      bus.publish(0, "alice", pcm);
      bus.publish(1, "bob", pcm);
      bus.publish(2, "cleo", pcm);

      const { turnFiles, mixFile } = bus.flush(tmpDir);

      expect(turnFiles.length).toBe(3);
      expect(existsSync(mixFile)).toBe(true);

      const mixBytes = new Uint8Array(readFileSync(mixFile));
      // Mix should have WAV header
      expect(mixBytes[0]).toBe(0x52); // R
      expect(mixBytes[1]).toBe(0x49); // I
      expect(mixBytes[2]).toBe(0x46); // F
      expect(mixBytes[3]).toBe(0x46); // F
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getSpeakers returns distinct speakers", () => {
    const bus = new AudioBus();
    bus.publish(0, "alice", new Uint8Array(100));
    bus.publish(1, "bob", new Uint8Array(100));
    bus.publish(2, "alice", new Uint8Array(100));

    const speakers = bus.getSpeakers();
    expect(speakers.length).toBe(2);
    expect(speakers).toContain("alice");
    expect(speakers).toContain("bob");
  });

  it("estimateWavDurationSec handles raw PCM (no header)", () => {
    // 1s of 16-bit / 22050Hz mono PCM
    const pcm = new Uint8Array(22050 * 2);
    const dur = estimateWavDurationSec(pcm);
    expect(dur).toBeCloseTo(1.0, 0);
  });

  it("isAudioNonBlank returns false for silent PCM", () => {
    const silent = new Uint8Array(22050 * 2);
    expect(isAudioNonBlank(silent)).toBe(false);
  });

  it("isAudioNonBlank returns true for non-trivial signal", () => {
    // Create a sine wave
    const pcm = new Uint8Array(22050 * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < 22050; i++) {
      const sample = Math.round(
        Math.sin((2 * Math.PI * 440 * i) / 22050) * 16000,
      );
      view.setInt16(i * 2, sample, true);
    }
    expect(isAudioNonBlank(pcm)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario file validation (always run)
// ---------------------------------------------------------------------------

describe("Canonical scenario", () => {
  it("has valid structure", () => {
    const scenarioPath = join(PKG_DIR, "scenarios", "canonical.json");
    expect(existsSync(scenarioPath)).toBe(true);
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8")) as {
      turns: Array<{
        turnIdx: number;
        speaker: string;
        prompt: string;
        expectedEmotion: string;
      }>;
      smokeSubset: number[];
      verificationThresholds: {
        minNonEmptyTranscripts: number;
        minAudioDurationSec: number;
        minDistinctSpeakers: number;
        emotionDetectedMinFraction: number;
      };
    };

    expect(Array.isArray(scenario.turns)).toBe(true);
    expect(scenario.turns.length).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(scenario.smokeSubset)).toBe(true);

    for (const turn of scenario.turns) {
      expect(typeof turn.turnIdx).toBe("number");
      expect(typeof turn.speaker).toBe("string");
      expect(typeof turn.prompt).toBe("string");
      expect(turn.prompt.length).toBeGreaterThan(0);
    }

    expect(
      scenario.verificationThresholds.minNonEmptyTranscripts,
    ).toBeGreaterThan(0);
    expect(scenario.verificationThresholds.minDistinctSpeakers).toBe(3);
  });

  it("smoke subset covers at least 3 distinct speakers", () => {
    const scenarioPath = join(PKG_DIR, "scenarios", "canonical.json");
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8")) as {
      turns: Array<{ turnIdx: number; speaker: string }>;
      smokeSubset: number[];
    };
    const smokeTurns = scenario.turns.filter((t) =>
      scenario.smokeSubset.includes(t.turnIdx),
    );
    const speakers = new Set(smokeTurns.map((t) => t.speaker));
    expect(speakers.size).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Character file validation (always run)
// ---------------------------------------------------------------------------

describe("Character files", () => {
  for (const name of ["alice", "bob", "cleo"]) {
    it(`${name}.json has required fields`, () => {
      const charPath = join(PKG_DIR, "characters", `${name}.json`);
      expect(existsSync(charPath)).toBe(true);
      const char = JSON.parse(readFileSync(charPath, "utf-8")) as {
        name: string;
        bio: string[];
        settings: Record<string, string>;
      };
      expect(typeof char.name).toBe("string");
      expect(Array.isArray(char.bio)).toBe(true);
      expect(typeof char.settings).toBe("object");
      expect(char.settings.GROQ_TTS_VOICE).toBeTruthy();
    });
  }

  it("all three agents have distinct TTS voices", () => {
    const voices = ["alice", "bob", "cleo"].map((name) => {
      const char = JSON.parse(
        readFileSync(join(PKG_DIR, "characters", `${name}.json`), "utf-8"),
      ) as { settings: { GROQ_TTS_VOICE: string } };
      return char.settings.GROQ_TTS_VOICE;
    });
    const unique = new Set(voices);
    expect(unique.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Integration smoke (only with GROQ_API_KEY)
// ---------------------------------------------------------------------------

const GROQ_KEY_SET = Boolean(process.env.GROQ_API_KEY);
const INTEGRATION_TIMEOUT_MS = 120_000; // 2 minutes for 4 turns

describe.skipIf(!GROQ_KEY_SET)(
  "Integration smoke (requires GROQ_API_KEY)",
  () => {
    let _runOutputDir: string | null = null;

    afterEach(() => {
      // Don't clean up — artefacts are the point
    });

    it(
      "runs 4-turn smoke scenario and passes verification",
      async () => {
        // Import runner lazily so the unit tests above don't trigger runtime init
        const { runDialogue } = await import("../runner/run-dialogue.ts");

        const runId = `smoke-${Date.now()}`;
        const outputDir = join(
          REPO_ROOT,
          "artifacts",
          "three-agent-dialogue",
          runId,
        );
        _runOutputDir = outputDir;

        const result = await runDialogue({
          scenarioId: "canonical",
          outputDir,
          smoke: true,
        });

        // Verify artefacts exist
        expect(existsSync(join(outputDir, "transcripts.json"))).toBe(true);
        expect(existsSync(join(outputDir, "emotion.json"))).toBe(true);
        expect(existsSync(join(outputDir, "turn-events.json"))).toBe(true);
        expect(existsSync(join(outputDir, "verification.json"))).toBe(true);
        expect(existsSync(join(outputDir, "mix.wav"))).toBe(true);

        // Read and validate the verification report from verifyRun
        const report = verifyRun(outputDir);

        // Core assertions
        expect(report.transcriptCount).toBeGreaterThan(0);
        expect(report.mixWavExists).toBe(true);
        expect(report.mixWavDurationSec).toBeGreaterThan(0);
        expect(
          report.verification.distinctSpeakersDetected,
        ).toBeGreaterThanOrEqual(3);
        expect(
          report.verification.emotionDetectedFraction,
        ).toBeGreaterThanOrEqual(0.8);
        expect(report.verification.turnsTaken).toBeGreaterThanOrEqual(4);

        // Check the run result directly
        expect(result.pass).toBe(true);
      },
      INTEGRATION_TIMEOUT_MS,
    );
  },
);

/** Tests the voice turn kind (voice-turn.ts) using plugin-local-inference's voice-workbench ground-truth mock services, asserting `executeVoiceTurn` drives the STT/TTS scenario path and writes expected artifacts. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  groundTruthMockServices,
  type VoiceScenario,
  type VoiceWorkbenchServices,
} from "@elizaos/plugin-local-inference/voice-workbench";
import type { ScenarioTurn } from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeVoiceTurn,
  voiceRunVerdict,
  voiceTurnAssertionFailures,
} from "./voice-turn.ts";

/** Assert `bytes` is a mono PCM16 RIFF/WAVE stream (format=1, channels=1, 16-bit). */
function assertWavPcm16(bytes: Buffer): void {
  expect(bytes.byteLength).toBeGreaterThan(44);
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  expect(bytes.toString("ascii", 12, 16)).toBe("fmt ");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint16(20, true)).toBe(1); // PCM
  expect(view.getUint16(22, true)).toBe(1); // mono
  expect(view.getUint16(34, true)).toBe(16); // 16-bit
  expect(bytes.toString("ascii", 36, 40)).toBe("data");
}

const VOICE_SCENARIO: VoiceScenario = {
  id: "scenario-runner-voice",
  classes: ["multi-speaker", "respond-no-respond"],
  participants: [
    { label: "alice", entityId: "entity-alice" },
    { label: "bob", entityId: "entity-bob" },
  ],
  turns: [
    { speaker: "alice", text: "Eliza what time is it", expectRespond: true },
    { speaker: "bob", text: "hey alice not you", expectRespond: false },
  ],
  assertions: { maxWer: 0.2, maxDer: 0.2, minRespondAccuracy: 0.9 },
};

function voiceTurn(extra: {
  voiceScenario?: VoiceScenario;
  voiceServices?: VoiceWorkbenchServices | null;
  allowVoiceSkip?: boolean;
}): ScenarioTurn {
  return { name: "voice", kind: "voice", ...extra } as ScenarioTurn;
}

describe("executeVoiceTurn", () => {
  it("runs the workbench with mocked services and passes", async () => {
    const exec = await executeVoiceTurn(
      voiceTurn({
        voiceScenario: VOICE_SCENARIO,
        voiceServices: groundTruthMockServices(),
      }),
    );
    expect(exec.responseBody?.status).toBe("ran");
    expect(exec.responseText).toContain("pass");
    expect(voiceRunVerdict(exec.responseBody!)).toBe("pass");
    expect(voiceTurnAssertionFailures(exec.responseBody)).toEqual([]);
  });

  it("fails skipped voice turns unless explicitly allowed", async () => {
    const exec = await executeVoiceTurn(
      voiceTurn({ voiceScenario: VOICE_SCENARIO }),
    );
    expect(exec.responseBody?.status).toBe("skipped");
    expect(voiceTurnAssertionFailures(exec.responseBody)[0]).toContain(
      "skipped",
    );
  });

  it("allows skipped voice turns for optional/manual coverage", async () => {
    const exec = await executeVoiceTurn(
      voiceTurn({ voiceScenario: VOICE_SCENARIO, allowVoiceSkip: true }),
    );
    expect(exec.responseBody?.status).toBe("skipped");
    expect(
      voiceTurnAssertionFailures(exec.responseBody, { allowVoiceSkip: true }),
    ).toEqual([]);
  });

  it("fails the turn when the workbench run regresses", async () => {
    const faulty: VoiceWorkbenchServices = {
      async observeTurn({ label }) {
        return {
          hypothesisTranscript: label.referenceTranscript,
          predictedSpeakerLabel: "alice", // wrong for bob
          eotDecided: true,
          responded: true, // wrong for the bystander
          inferredEntities: [],
          matchedEntityId: label.entityId ?? null,
        };
      },
    };
    const exec = await executeVoiceTurn(
      voiceTurn({ voiceScenario: VOICE_SCENARIO, voiceServices: faulty }),
    );
    expect(voiceRunVerdict(exec.responseBody!)).toBe("fail");
    const failures = voiceTurnAssertionFailures(exec.responseBody);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("regressed");
  });

  it("fails when the turn has no voiceScenario", async () => {
    const exec = await executeVoiceTurn(voiceTurn({}));
    expect(exec.responseBody).toBeUndefined();
    expect(voiceTurnAssertionFailures(exec.responseBody)[0]).toContain(
      "voiceScenario",
    );
  });
});

describe("executeVoiceTurn — resolveAudioCaptureSink under --run-dir (#8934)", () => {
  const tempDirs: string[] = [];
  const previousRunDir = process.env.ELIZA_LIFEOPS_RUN_DIR;

  afterEach(() => {
    if (previousRunDir === undefined) {
      delete process.env.ELIZA_LIFEOPS_RUN_DIR;
    } else {
      process.env.ELIZA_LIFEOPS_RUN_DIR = previousRunDir;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes run-dir-relative .wav artifacts when ELIZA_LIFEOPS_RUN_DIR is set", async () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "voice-turn-run-"));
    tempDirs.push(runDir);
    process.env.ELIZA_LIFEOPS_RUN_DIR = runDir;

    const exec = await executeVoiceTurn(
      voiceTurn({
        voiceScenario: VOICE_SCENARIO,
        voiceServices: groundTruthMockServices(),
      }),
    );

    const run = exec.responseBody;
    expect(run?.status).toBe("ran");
    const artifacts = run?.audioArtifacts ?? [];
    expect(artifacts.length).toBeGreaterThan(0);

    // The full corpus is written under <runDir>/audio/<scenarioId>/corpus.wav.
    const generated = artifacts.find((a) => a.kind === "generated");
    expect(generated?.path).toBe(`audio/${VOICE_SCENARIO.id}/corpus.wav`);
    // Plus at least one consumed per-turn slice.
    expect(artifacts.some((a) => a.kind === "consumed")).toBe(true);

    for (const artifact of artifacts) {
      // Paths are RELATIVE to the run dir (the viewer is served from there).
      expect(path.isAbsolute(artifact.path)).toBe(false);
      expect(artifact.path.startsWith(`audio/${VOICE_SCENARIO.id}/`)).toBe(
        true,
      );
      const absolute = path.join(runDir, artifact.path);
      expect(existsSync(absolute)).toBe(true);
      assertWavPcm16(readFileSync(absolute));
    }
  });

  it("writes no artifacts when no run dir is configured", async () => {
    delete process.env.ELIZA_LIFEOPS_RUN_DIR;

    const exec = await executeVoiceTurn(
      voiceTurn({
        voiceScenario: VOICE_SCENARIO,
        voiceServices: groundTruthMockServices(),
      }),
    );

    expect(exec.responseBody?.status).toBe("ran");
    expect(exec.responseBody?.audioArtifacts).toBeUndefined();
  });
});

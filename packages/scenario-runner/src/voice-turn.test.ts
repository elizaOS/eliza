import {
  groundTruthMockServices,
  type VoiceScenario,
  type VoiceWorkbenchServices,
} from "@elizaos/plugin-local-inference/voice-workbench";
import type { ScenarioTurn } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  executeVoiceTurn,
  voiceRunVerdict,
  voiceTurnAssertionFailures,
} from "./voice-turn.ts";

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

  it("skips (not fails) when no services are provisioned", async () => {
    const exec = await executeVoiceTurn(
      voiceTurn({ voiceScenario: VOICE_SCENARIO }),
    );
    expect(exec.responseBody?.status).toBe("skipped");
    expect(voiceTurnAssertionFailures(exec.responseBody)).toEqual([]);
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

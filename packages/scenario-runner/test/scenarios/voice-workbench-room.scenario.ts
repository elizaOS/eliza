/**
 * Example `voice` turn scenario (#8785) — a Voice Workbench scenario run as a
 * first-class scenario-runner turn. Uses the ground-truth mock services so it is
 * deterministic in CI (no model); swap in a real services adapter where a local
 * backend is provisioned, or omit `voiceServices` to have the turn `skip`.
 */

import { groundTruthMockServices } from "@elizaos/plugin-local-inference/voice-workbench";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "voice-workbench-room",
  title: "Voice Workbench: multi-speaker room over a voice turn",
  domain: "voice",
  tags: ["deterministic", "voice"],
  lane: "pr-deterministic",
  turns: [
    {
      name: "multi-speaker voice scenario",
      kind: "voice",
      voiceScenario: {
        id: "voice-room-demo",
        classes: ["multi-speaker", "respond-no-respond", "voice-recognition"],
        participants: [
          { label: "alice", entityId: "entity-alice", isOwner: true },
          { label: "bob", entityId: "entity-bob" },
        ],
        turns: [
          {
            speaker: "alice",
            text: "Eliza what is on my calendar",
            expectRespond: true,
          },
          {
            speaker: "bob",
            text: "hey alice did you see the game",
            expectRespond: false,
          },
          {
            speaker: "alice",
            text: "Eliza thanks that is all",
            expectRespond: true,
          },
        ],
        assertions: { maxWer: 0.2, maxDer: 0.2, minRespondAccuracy: 0.9 },
      },
      voiceServices: groundTruthMockServices(),
      assertTurn(execution) {
        const run = execution.responseBody as
          | { status: string; cases: Array<{ passed: boolean }> }
          | undefined;
        if (!run) return "voice turn produced no run";
        if (run.status === "ran" && !run.cases.every((c) => c.passed)) {
          return "voice scenario cases regressed";
        }
      },
    },
  ],
});

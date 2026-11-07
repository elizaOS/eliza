/** Builds cryptographically bound live-trajectory rows for evidence-validator tests. */

import { createHash } from "node:crypto";
import {
  CONTENT_CONTEXT_FAMILIES,
  CONTENT_CONTEXT_LIVE_OBSERVER_SCHEMA_VERSION,
  CONTENT_CONTEXT_LIVE_TRAJECTORY_SCHEMA_VERSION,
  contentContextCanonicalEvidenceSha256,
} from "../progressive-content-evidence.ts";

/** Return the exact five-by-six qualified trajectory matrix required by the validator. */
export function createProgressiveContentLiveTrajectoryEvidenceFixture(
  commit: string,
  corpusManifestSha256: string,
): string {
  return Array.from({ length: 5 }, (_, repetition) =>
    CONTENT_CONTEXT_FAMILIES.map((family) => {
      const trajectory = {
        schemaVersion: "elizaos.content-context.normalized-trajectory.v1",
        messages: [{ role: "user", content: `find ${family} late evidence` }],
        toolCalls: [
          { name: "READ", offset: 0 },
          { name: "READ", offset: 65_536 },
        ],
        modelCalls: [{ purpose: "planner", response: "continue" }],
        finalAnswer: `recovered ${family} answer`,
      };
      const answerSha256 = createHash("sha256")
        .update(trajectory.finalAnswer)
        .digest("hex");
      const observerEvidence = {
        schemaVersion: CONTENT_CONTEXT_LIVE_OBSERVER_SCHEMA_VERSION,
        judgeProvider: "openai",
        judgeModel: "gpt-5.4",
        judgeResponse: { decision: "qualified", citationsVerified: true },
        expectedAnswerSha256: answerSha256,
        observedAnswerSha256: answerSha256,
        continuationDiscovered: true,
        lateEvidenceRecovered: true,
        exactAnswer: true,
        answerLeakageDetected: false,
        canaryLeakageDetected: false,
        toolCalls: 2,
        noProgressReads: 0,
      };
      return JSON.stringify({
        schemaVersion: CONTENT_CONTEXT_LIVE_TRAJECTORY_SCHEMA_VERSION,
        repetition,
        family,
        status: "passed",
        commit,
        corpusManifestSha256,
        providerQualified: true,
        provider: "openai",
        model: "gpt-5.4",
        continuationDiscovered: true,
        lateEvidenceRecovered: true,
        exactAnswer: true,
        answerLeakageDetected: false,
        canaryLeakageDetected: false,
        toolCalls: 2,
        noProgressReads: 0,
        latencyMs: 100,
        inputTokens: 1_000,
        outputTokens: 100,
        costUsd: 0.01,
        controllerDecision: "qualified",
        observerEvidence,
        observerEvidenceSha256:
          contentContextCanonicalEvidenceSha256(observerEvidence),
        trajectory,
        trajectorySha256: contentContextCanonicalEvidenceSha256(trajectory),
      });
    }),
  )
    .flat()
    .join("\n");
}

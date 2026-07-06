/**
 * Evidence scenario for #9963.
 *
 * The prep script in `test-results/evidence/9963-live-restore-prep.ts`
 * creates a real local encrypted backup, wipes DB/media/vault state, restores
 * it, then this scenario runs against the restored PGlite directory. The turn
 * must recall the fact that only exists if the restored DB is active.
 */

import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

const RECALL_PHRASE = "silver comet orchid";
const RECALL_QUESTION =
  "Before this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.";

type RuntimeWithScenarioLlmFixtures = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

function runtimeWithFixtures(value: unknown): RuntimeWithScenarioLlmFixtures {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "backup.restore-recall seed: runtime did not expose registerPlugin",
    );
  }
  return value as RuntimeWithScenarioLlmFixtures;
}

function restoreRecallFixtures(): Array<Record<string, unknown>> {
  return [
    {
      name: "backup-restore-recall-stage1",
      match: (call: {
        modelType: string;
        latestUserText: string;
        toolNames: string[];
      }) => {
        return (
          call.modelType === ModelType.RESPONSE_HANDLER &&
          call.latestUserText.includes(RECALL_QUESTION) &&
          call.latestUserText.includes(RECALL_PHRASE) &&
          call.toolNames.includes("HANDLE_RESPONSE")
        );
      },
      response: {
        shouldRespond: "RESPOND",
        contexts: ["simple"],
        intents: ["recall_backup_phrase"],
        replyText: RECALL_PHRASE,
        threadOps: [],
        candidateActionNames: [],
        facts: [],
        relationships: [],
        addressedTo: [],
        emotion: "none",
      },
      times: 1,
    },
  ];
}

export default scenario({
  lane: "live-only",
  id: "backup.restore-recall",
  title: "Agent recalls a restored memory after local backup restore",
  domain: "backup",
  tags: ["backup", "restore", "live-model", "issue-9963"],
  description:
    "Pre-run evidence restores a local encrypted backup containing the phrase 'silver comet orchid'. The live model must answer with that restored phrase.",

  seed: [
    {
      type: "custom",
      name: "register-backup-restore-recall-fixture",
      apply: async (ctx) => {
        runtimeWithFixtures(ctx.runtime).scenarioLlmFixtures?.register(
          ...restoreRecallFixtures(),
        );
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Backup restore recall",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "ask-restored-recall-phrase",
      room: "main",
      text: RECALL_QUESTION,
      responseIncludesAll: ["silver", "comet", "orchid"],
      responseExcludes: ["I don't", "do not know", "not have"],
      timeoutMs: 120_000,
    },
  ],
});

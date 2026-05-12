/**
 * Batch modify of ~50 messages — agent must use a single batchModify call
 * (or efficient pagination), NOT one call per message.
 *
 * Failure modes guarded:
 *   - one modify call per message (50x quota usage)
 *   - skipping the modify entirely
 *
 * Cited: 03-coverage-gap-matrix.md — batch-modify scale.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkBatchedNotIndividual(
  ctx: ScenarioContext,
): string | undefined {
  // Walk Gmail mock requests if exposed via ctx — fall back to action count.
  const modifyActions = ctx.actionsCalled.filter((a) => {
    const blob = JSON.stringify({
      n: a.actionName,
      p: a.parameters,
    }).toLowerCase();
    return blob.includes("archive") || blob.includes("modify") || blob.includes("batch");
  });
  if (modifyActions.length > 10) {
    return `Agent fired ${modifyActions.length} archive/modify actions instead of batching. Expected <=10 calls.`;
  }
  return undefined;
}

export default scenario({
  id: "gmail.batch-modify-50-messages",
  title: "Bulk archive of ~50 messages goes through batchModify, not per-message",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "batch", "scale", "quota"],
  isolation: "per-scenario",
  requires: {
    credentials: ["gmail:test-owner"],
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Gmail Batch Modify Scale",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bulk-archive-50",
      room: "main",
      text: "Archive every newsletter, promotion, and notification email in my inbox in one operation. There are about 50 of them.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm bulk archive of newsletters/promos/notifications efficiently. Must not claim individual per-message archives.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "batched-not-per-message",
      predicate: checkBatchedNotIndividual,
    },
    {
      type: "gmailBatchModify",
      body: {
        removeLabelIds: "MESSAGE",
      },
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailDraftCreated",
      expected: false,
    },
    judgeRubric({
      name: "gmail-batch-50-rubric",
      threshold: 0.7,
      description:
        "Agent used efficient batchModify to archive ~50 messages instead of N individual calls.",
    }),
  ],
});

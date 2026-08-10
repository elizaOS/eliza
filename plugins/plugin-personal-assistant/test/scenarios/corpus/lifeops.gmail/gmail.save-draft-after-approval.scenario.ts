/**
 * Two-turn draft persistence: propose → approve → save. The agent proposes a
 * reply, then saves it to Gmail only after the user confirms the draft.
 *
 * Failure modes guarded:
 *   - claiming that Gmail MCP delivered the message
 *   - failing to save the approved draft
 *
 * Official Gmail MCP supports draft creation but not message delivery.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "gmail.save-draft-after-approval",
  title: "Draft → explicit approval → Gmail draft saved",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "draft", "approval", "two-turn"],
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
      title: "Gmail Draft Save After Approval",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "sarah-product-brief.eml",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "draft-reply",
      room: "main",
      text: "Draft a reply to Sarah's product brief confirming Friday afternoon works. Don't send yet.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must present a draft that mentions Friday afternoon and explicitly does not claim it was sent.",
      },
    },
    {
      kind: "message",
      name: "approve-and-save",
      room: "main",
      text: "Looks good — save it to my Gmail drafts.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must confirm that the draft was saved, and must not claim the email was sent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailDraftCreated",
    },
    judgeRubric({
      name: "gmail-save-after-approval-rubric",
      threshold: 0.7,
      description:
        "Agent proposed a reply on turn 1, then saved a Gmail draft on turn 2 without claiming delivery.",
    }),
  ],
  cleanup: [
    {
      type: "gmailDeleteDrafts",
      account: "test-owner",
      tag: "eliza-e2e",
    },
  ],
});

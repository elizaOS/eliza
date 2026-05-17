/**
 * Two-turn send: draft → approve → send. The agent creates a draft, the
 * user explicitly says "send it", and only then does Gmail send fire.
 *
 * Failure modes guarded:
 *   - sending immediately without intermediate draft
 *   - failing to send after explicit approval
 *
 * Cited: 03-coverage-gap-matrix.md — send-after-approval round trip.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.send-draft-after-approval",
  title: "Draft → explicit approval → Gmail send fires",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "send", "approval", "two-turn"],
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
      title: "Gmail Send After Approval",
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
      name: "approve-and-send",
      room: "main",
      text: "Looks good — send it.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must confirm that the draft was sent after the user's explicit approval.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailDraftCreated",
    },
    {
      type: "gmailMessageSent",
    },
    {
      type: "gmailMockRequest",
      method: "POST",
      path: "/gmail/v1/users/me/drafts",
      minCount: 1,
    },
    judgeRubric({
      name: "gmail-send-after-approval-rubric",
      threshold: 0.7,
      description:
        "Agent drafted on turn 1, then sent on turn 2 only after explicit user approval.",
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

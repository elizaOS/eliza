/**
 * Draft with CC and BCC — the agent must include both recipient sets in the
 * draft mock request body, and must NOT confuse cc/bcc/to roles.
 *
 * Failure modes guarded:
 *   - CC'ing the BCC recipient
 *   - dropping BCC entirely
 *   - sending without approval
 *
 * Cited: 03-coverage-gap-matrix.md — multi-recipient drafts.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.create-draft-with-cc-bcc",
  title: "Draft with CC and BCC keeps roles distinct",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "draft", "cc", "bcc"],
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
      title: "Gmail Draft CC BCC",
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
      name: "draft-with-cc-bcc",
      room: "main",
      text: "Draft an email to alice@example.com about the project update. CC bob@example.com on it, and BCC counsel@legal.example. Don't send.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must produce a draft that lists alice as TO, bob as CC, and counsel@legal.example as BCC. Must not confuse the roles or claim it was sent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailDraftCreated",
    },
    {
      type: "gmailMockRequest",
      method: "POST",
      path: "/gmail/v1/users/me/drafts",
      minCount: 1,
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    judgeRubric({
      name: "gmail-draft-cc-bcc-rubric",
      threshold: 0.7,
      description:
        "Agent drafted with distinct TO (alice), CC (bob), BCC (counsel@legal.example) fields and did not send.",
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

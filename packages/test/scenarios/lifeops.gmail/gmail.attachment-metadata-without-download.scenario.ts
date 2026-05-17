/**
 * Attachment metadata — the agent must surface attachment filename/size from
 * the message metadata WITHOUT downloading the attachment bytes (no
 * `attachments/get` call required if the user only asked "what's attached").
 *
 * Failure modes guarded:
 *   - downloading attachments wholesale when metadata suffices
 *   - fabricating attachment names that aren't in the fixture
 *
 * Cited: 03-coverage-gap-matrix.md — attachment metadata.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.attachment-metadata-without-download",
  title: "Attachment metadata surfaced without downloading bytes",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "attachment", "metadata"],
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
      title: "Gmail Attachment Metadata",
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
      name: "ask-attachment-meta",
      room: "main",
      text: "What attachments are on the most recent message from Julia? Just the filenames — don't open them.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must list attachment filename(s) from message metadata, not fabricate or claim to have opened the file.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailMockRequest",
      method: "GET",
      path: ["/gmail/v1/users/me/messages", "/gmail/v1/users/me/messages/"],
      minCount: 1,
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
      name: "gmail-attachment-metadata-rubric",
      threshold: 0.7,
      description:
        "Agent reported attachment metadata from the message fetch without downloading bytes or fabricating filenames.",
    }),
  ],
});

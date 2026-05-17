/**
 * Gmail list-unread — agent must hit Gmail mock list endpoint with an
 * unread filter that bounds "this morning" to a sane window.
 *
 * Failure modes guarded:
 *   - listing ALL mail instead of unread only
 *   - listing without a date bound (fetches months back)
 *   - claiming a count without calling the mock
 *
 * Cited: 03-coverage-gap-matrix.md — list unread with time bound.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.list-unread-this-morning",
  title: "List unread Gmail from this morning, bounded query",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "list", "unread", "time-bound"],
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
      title: "Gmail List Unread Morning",
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
      name: "list-unread-morning",
      room: "main",
      text: "What unread email came in this morning?",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must list or summarize unread messages from a recent time window, not claim the inbox is empty when fixture rows exist.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
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
    {
      type: "gmailNoRealWrite",
    },
    judgeRubric({
      name: "gmail-list-unread-morning-rubric",
      threshold: 0.7,
      description:
        "Agent listed unread Gmail bounded to this morning, hitting the messages.list mock, without sending or drafting anything.",
    }),
  ],
});

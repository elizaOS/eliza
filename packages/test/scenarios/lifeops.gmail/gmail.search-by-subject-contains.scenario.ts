/**
 * Gmail search-by-subject — `subject:` operator search.
 *
 * Failure modes guarded:
 *   - missing `subject:` filter (broad scan)
 *   - fabricated results without mock hit
 *
 * Cited: 03-coverage-gap-matrix.md — search-by-subject.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.search-by-subject-contains",
  title: "Gmail search by subject substring uses subject: operator",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "search", "subject"],
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
      title: "Gmail Search By Subject",
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
      name: "search-subject-invoice",
      room: "main",
      text: "Search my Gmail for anything with 'invoice' in the subject line.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must show targeted search results (or honestly state 'no matches') for the subject filter — not list unrelated inbox.",
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
      type: "gmailNoRealWrite",
    },
    judgeRubric({
      name: "gmail-search-by-subject-rubric",
      threshold: 0.7,
      description:
        "Agent issued a subject-bounded Gmail search and reported matches (or honestly: no matches) without enumerating unrelated inbox.",
    }),
  ],
});

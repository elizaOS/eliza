/**
 * Gmail search-by-label — `label:` operator search.
 *
 * Failure modes guarded:
 *   - searching all mail instead of label-bound
 *   - fabricating labels that don't exist
 *
 * Cited: 03-coverage-gap-matrix.md — label-bound search.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.search-by-label",
  title: "Gmail search by label uses label: operator",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "search", "label"],
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
      title: "Gmail Search By Label",
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
      name: "search-by-label-finance",
      room: "main",
      text: "Show me everything in Gmail labeled 'Finance'.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must scope the search to the Finance label and not enumerate unrelated mail. May honestly report 'no matches'.",
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
      name: "gmail-search-by-label-rubric",
      threshold: 0.7,
      description:
        "Agent searched within the Finance label scope and produced label-specific results without leaking unrelated mail.",
    }),
  ],
});

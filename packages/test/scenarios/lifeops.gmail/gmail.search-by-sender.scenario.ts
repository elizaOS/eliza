/**
 * Gmail search-by-sender — agent issues a Gmail search with `from:` operator
 * to the mock when the user asks "what did Sarah send me?".
 *
 * Failure modes guarded:
 *   - full-inbox scan instead of targeted search
 *   - missing `q=from:` operator
 *   - fabricating Sarah's mail
 *
 * Cited: 03-coverage-gap-matrix.md — search-by-sender.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.search-by-sender",
  title: "Gmail search by sender uses from: operator",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "search", "sender"],
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
      title: "Gmail Search By Sender",
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
      name: "search-from-sarah",
      room: "main",
      text: "What has Sarah sent me recently? Just from her.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must specifically reference mail from Sarah using a targeted search, not enumerate the whole inbox.",
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
      name: "gmail-search-by-sender-rubric",
      threshold: 0.7,
      description:
        "Agent searched Gmail by sender and summarized Sarah's mail specifically without listing unrelated inbox.",
    }),
  ],
});

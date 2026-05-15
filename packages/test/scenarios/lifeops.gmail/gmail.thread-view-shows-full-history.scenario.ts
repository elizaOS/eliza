/**
 * Thread view — when the user asks to "show me the whole thread", the
 * agent must hit the thread/get endpoint (not just messages/get for one
 * message) and return all messages in chronological order.
 *
 * Failure modes guarded:
 *   - returning only the latest message
 *   - returning thread out of order
 *
 * Cited: 03-coverage-gap-matrix.md — full-thread view.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "gmail.thread-view-shows-full-history",
  title: "Gmail thread view fetches full message history",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "thread", "history"],
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
      title: "Gmail Thread Full History",
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
      name: "show-thread-history",
      room: "main",
      text: "Show me the entire email thread with Julia from start to finish, in order.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must show or summarize multiple messages in the thread (not just one), in chronological order.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailMockRequest",
      method: "GET",
      path: ["/gmail/v1/users/me/messages", "/gmail/v1/users/me/threads"],
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
      name: "gmail-thread-history-rubric",
      threshold: 0.7,
      description:
        "Agent fetched the full Julia thread via the mock and summarized messages in order, not just the latest.",
    }),
  ],
});

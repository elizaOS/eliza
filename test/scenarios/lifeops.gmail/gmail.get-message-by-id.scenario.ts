/**
 * Gmail get message by id — agent fetches a specific message via the mock
 * `/gmail/v1/users/me/messages/{id}` endpoint when given an explicit ID.
 *
 * Failure modes guarded:
 *   - calling list then filtering (wasteful, fragile)
 *   - fabricating the body without hitting the mock
 *
 * Cited: 03-coverage-gap-matrix.md — single-message fetch by id.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const MESSAGE_ID = "msg-julia";

export default scenario({
  id: "gmail.get-message-by-id",
  title: "Get a specific Gmail message by ID via mock get endpoint",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "get", "lookup"],
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
      title: "Gmail Get By ID",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: [MESSAGE_ID],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-message-by-id",
      room: "main",
      text: `Pull up Gmail message ${MESSAGE_ID} and tell me what it says.`,
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must describe message contents fetched from the mock, not invent content. Reply must reference the actual message.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailMockRequest",
      method: "GET",
      path: ["/gmail/v1/users/me/messages", `/gmail/v1/users/me/messages/${MESSAGE_ID}`],
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
      name: "gmail-get-by-id-rubric",
      threshold: 0.7,
      description:
        "Agent fetched the specific Gmail message ID via the mock and described its actual contents without fabricating.",
    }),
  ],
});

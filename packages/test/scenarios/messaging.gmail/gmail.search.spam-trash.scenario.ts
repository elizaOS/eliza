/** Scenario fixture for gmail search spam trash; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  gmailNoWriteOnTurns,
  gmailSpamTrashDiscovery,
} from "./_gmail-contracts.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.search.spam-trash",
  title: "Search Gmail spam and trash without modifying messages",
  domain: "messaging.gmail",
  evidenceScope: "connector-contract",
  tags: ["messaging", "gmail", "search", "spam", "read-only"],
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
      title: "Gmail Spam Search",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: ["msg-spam", "msg-trash-receipt", "msg-julia"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read spam notice",
      room: "main",
      text: "Look across Gmail spam and trash for the suspicious account notice and read it. Do not confuse it with the legitimate lunch receipt in trash or Julia's inbox email, and do not modify anything.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must search spam/trash, read the suspicious account notice, distinguish it from the legitimate trash receipt and Julia's inbox email, and keep the run read-only.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: ["search", "read"],
      turn: "read spam notice",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
      turn: "read spam notice",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg-spam",
      minCount: 1,
      turn: "read spam notice",
    },
    {
      type: "gmailBatchModify",
      expected: false,
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
    gmailNoWriteOnTurns(
      "spam and trash search is read-only",
      "read spam notice",
    ),
    gmailSpamTrashDiscovery(
      "provider search explicitly covers spam and trash",
      "read spam notice",
    ),
    judgeRubric({
      name: "gmail-spam-search-readonly-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant looked in Gmail spam/trash and read the matching message without performing any Gmail write.",
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

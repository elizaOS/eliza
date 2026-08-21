/** Scenario fixture for gmail triage high priority client; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import { gmailNoWriteOnTurns } from "./_gmail-contracts.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.triage.high-priority-client",
  title: "Triage flags high-priority client email",
  domain: "messaging.gmail",
  evidenceScope: "connector-contract",
  tags: ["messaging", "gmail", "triage", "parameter-extraction"],
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
      title: "Gmail Triage High-Priority",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "high-priority-client.eml",
      requiredMessageIds: [
        "msg-urgent-client",
        "msg-sarah",
        "msg-medium-newsletter",
      ],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage high priority",
      room: "main",
      text: "Triage my inbox — anything I need to respond to right now?",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must identify Maya Ortiz's launch-blocking message as the immediate priority, distinguish it from Sarah's ordinary request and the Medium newsletter, and cite today's 2 PM deadline.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: "triage",
      turn: "triage high priority",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
      turn: "triage high priority",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg-urgent-client",
      minCount: 1,
      turn: "triage high priority",
    },
    {
      type: "gmailNoRealWrite",
    },
    gmailNoWriteOnTurns(
      "high-priority triage is read-only",
      "triage high priority",
    ),
    judgeRubric({
      name: "gmail-high-priority-triage-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant prioritized Maya's IMPORTANT launch-blocking email and its 2 PM deadline over realistic unread decoys without writing Gmail state.",
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

/** Scenario fixture for gmail triage unread; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import { gmailNoWriteOnTurns } from "./_gmail-contracts.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.triage.unread",
  title: "Triage unread Gmail inbox",
  domain: "messaging.gmail",
  evidenceScope: "connector-contract",
  tags: ["messaging", "gmail", "triage", "happy-path", "smoke"],
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
      title: "Gmail Triage Unread",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "unread-inbox.eml",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage unread",
      room: "main",
      text: "Triage my unread email",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must summarize unread Gmail and distinguish messages that need the owner's attention from lower-value inbox items. It must not claim it modified or sent anything.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: "MESSAGE",
      subaction: "triage",
      turn: "triage unread",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
      turn: "triage unread",
    },
    {
      type: "gmailNoRealWrite",
    },
    gmailNoWriteOnTurns("unread triage is read-only", "triage unread"),
    judgeRubric({
      name: "gmail-unread-triage-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant used Gmail triage to summarize unread mail without modifying or sending Gmail messages.",
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

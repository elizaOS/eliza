/** Scenario fixture for gmail bulk apply label name resolution; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import { gmailDiscoveryBeforeWrite } from "./_gmail-contracts.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.bulk.apply-label.name-resolution",
  title: "Resolve Gmail label name before applying it",
  domain: "messaging.gmail",
  evidenceScope: "connector-contract",
  tags: ["messaging", "gmail", "bulk", "label", "inbox-zero"],
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
      title: "Gmail Label Name Resolution",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: ["msg-finance", "msg-finance-receipt", "msg-julia"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "select finance message",
      room: "main",
      text: "Find the two Gmail finance messages about invoice 4831 and receipt 9027 that need filing under the existing label named eliza-e2e. Leave Julia's person-to-person email alone, and do not change anything yet.",
      responseJudge: {
        minimumScore: 0.72,
        rubric:
          "The assistant must identify exactly the invoice 4831 and receipt 9027 messages, exclude Julia's person-to-person email, and keep this step read-only.",
      },
    },
    {
      kind: "message",
      name: "apply resolved label",
      room: "main",
      text: "Apply the existing Gmail label named eliza-e2e to those two selected finance messages only. I confirm this Gmail label change.",
      responseJudge: {
        minimumScore: 0.78,
        rubric:
          "The assistant must resolve the human label name through Gmail labels, apply only the resolved label to the two selected finance messages, and not silently create or guess a different label.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: ["search", "read"],
      minCount: 1,
      turn: "select finance message",
    },
    {
      type: "gmailMockRequest",
      method: "GET",
      path: "/gmail/v1/users/me/labels",
      minCount: 1,
      maxCount: 1,
      turn: "apply resolved label",
    },
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: "manage",
      operation: "apply_label",
      fields: {
        labelIds: "Label_1",
      },
      turn: "apply resolved label",
      minCount: 1,
      maxCount: 1,
    },
    {
      type: "gmailBatchModify",
      body: {
        ids: ["msg-finance", "msg-finance-receipt"],
        addLabelIds: ["Label_1"],
      },
      turn: "apply resolved label",
      exactArrays: true,
    },
    {
      type: "gmailDraftCreated",
      expected: false,
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
    },
    gmailDiscoveryBeforeWrite({
      name: "finance messages discovered before exact label write",
      discoveryTurn: "select finance message",
      writeTurn: "apply resolved label",
      requiredReadPaths: [
        "/gmail/v1/users/me/messages/msg-finance",
        "/gmail/v1/users/me/messages/msg-finance-receipt",
      ],
      writePath: "/gmail/v1/users/me/messages/batchModify",
    }),
    judgeRubric({
      name: "gmail-label-name-resolution-rubric",
      threshold: 0.78,
      description:
        "End-to-end: the assistant selected exactly two finance messages, excluded the decoy, resolved the existing Gmail label name to its Gmail label ID, and applied that label without drafting, sending, or guessing.",
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

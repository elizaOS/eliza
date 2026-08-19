/** Scenario fixture for gmail bulk archive newsletters; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import { gmailDiscoveryBeforeWrite } from "./_gmail-contracts.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.bulk.archive-newsletters",
  title: "Bulk archive exactly two selected Gmail newsletters",
  domain: "messaging.gmail",
  evidenceScope: "connector-contract",
  tags: ["messaging", "gmail", "bulk", "archive", "inbox-zero"],
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
      title: "Gmail Archive Newsletter",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      requiredMessageIds: [
        "msg-newsletter",
        "msg-medium-newsletter",
        "msg-sarah",
        "msg-finance",
      ],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "locate newsletter",
      room: "main",
      text: "Find the Weekly Digest and Medium Daily Digest newsletters in Gmail. Verify both are automated newsletters, and exclude Sarah's email and invoice 4831.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must locate exactly the Weekly Digest and Medium Daily Digest newsletters and distinguish both from person-to-person and invoice mail.",
      },
    },
    {
      kind: "message",
      name: "archive newsletter",
      room: "main",
      text: "Archive those two newsletters now, and only those two newsletters.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must bind one bulk archive operation to the two newsletters selected in the previous step. It must not archive Sarah's message, finance mail, spam, or unrelated inbox items.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: ["search", "read"],
      minCount: 1,
      turn: "locate newsletter",
    },
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: "manage",
      operation: "archive",
      turn: "archive newsletter",
      minCount: 1,
      maxCount: 1,
    },
    {
      type: "gmailBatchModify",
      body: {
        ids: ["msg-newsletter", "msg-medium-newsletter"],
        removeLabelIds: ["INBOX"],
      },
      turn: "archive newsletter",
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
      name: "both newsletters discovered before exact bulk archive",
      discoveryTurn: "locate newsletter",
      writeTurn: "archive newsletter",
      requiredReadPaths: [
        "/gmail/v1/users/me/messages/msg-newsletter",
        "/gmail/v1/users/me/messages/msg-medium-newsletter",
      ],
      writePath: "/gmail/v1/users/me/messages/batchModify",
    }),
    judgeRubric({
      name: "gmail-archive-newsletter-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant resolved two newsletter targets, excluded person and finance decoys, and archived exactly those two IDs in one mock batchModify write.",
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

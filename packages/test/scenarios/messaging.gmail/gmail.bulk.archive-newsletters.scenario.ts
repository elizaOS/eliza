/** Scenario fixture for gmail bulk archive newsletters; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_SCENARIO_MESSAGES,
  gmailFixture,
  gmailSearchFixture,
  gmailThreadFixture,
} from "./_gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.bulk.archive-newsletters",
  title: "Bulk archive selected Gmail newsletter",
  domain: "messaging.gmail",
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
    gmailSearchFixture([GMAIL_SCENARIO_MESSAGES.newsletter]),
    gmailThreadFixture([GMAIL_SCENARIO_MESSAGES.newsletter]),
    gmailFixture({
      tool: "unlabel_thread",
      arguments: { threadId: "thr-news", labelIds: ["INBOX"] },
      structuredContent: {
        threadId: "thr-news",
        removedLabelIds: ["INBOX"],
      },
    }),
  ],
  turns: [
    {
      kind: "message",
      name: "locate newsletter",
      room: "main",
      text: "Find the Weekly Digest newsletter in Gmail and verify it is the automated digest, not a person or invoice.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must locate the Weekly Digest newsletter and distinguish it from person-to-person mail or invoice mail.",
      },
    },
    {
      kind: "message",
      name: "archive newsletter",
      room: "main",
      text: "Archive that newsletter now, and only that newsletter.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must bind the archive operation to the newsletter selected in the previous step. It must not archive person-to-person messages, finance mail, spam, or unrelated inbox items.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: ["search", "read"],
      minCount: 1,
    },
    {
      type: "gmailActionArguments",
      actionName: ["MESSAGE", "MESSAGE"],
      subaction: "manage",
      operation: "archive",
    },
    {
      type: "mcpToolCalls",
      provider: "google",
      resource: "gmail",
      calls: [
        { tool: "search_threads" },
        {
          tool: "unlabel_thread",
          arguments: { threadId: "thr-news", labelIds: ["INBOX"] },
        },
      ],
    },
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "create_draft",
      expected: false,
    },
    judgeRubric({
      name: "gmail-archive-newsletter-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant resolved the newsletter target first and then archived only that Gmail thread through the official unlabel_thread tool.",
    }),
  ],
});

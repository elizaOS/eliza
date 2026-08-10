/**
 * Live-model email-reply-draft outcome for the LifeOps email capability: seeds a
 * real inbound email, asks the agent to DRAFT a reply, and asserts the result
 * against the official Gmail MCP boundary — a draft was actually created, its
 * body carries the right recipient and requested Friday-afternoon availability,
 * and nothing was delivered. The MESSAGE `draft_reply` subaction is the path
 * under test; the curated Gmail surface has no send tool.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  gmailCreateDraftFixture,
  gmailSearchFixture,
} from "../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "email-reply-draft-outcome",
  title: "Email reply draft is created with correct body and never sent",
  domain: "lifeops",
  tags: ["lifeops", "gmail", "inbox", "draft", "email-reply-draft", "outcome"],
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
      title: "LifeOps Email Reply Draft",
    },
  ],
  seed: [
    gmailSearchFixture([GMAIL_MCP_MESSAGES.sarahProductBrief]),
    gmailCreateDraftFixture({ clearLedger: false }),
  ],
  turns: [
    {
      kind: "message",
      name: "draft reply to sarah without sending",
      room: "main",
      text: "Draft a reply to Sarah's latest email letting her know I can review the product brief Friday afternoon. Don't send it — just leave it as a draft.",
      // Outcome (content) assertion on the conversational turn: the agent must
      // present the drafted body (the Friday-afternoon availability) and must
      // NOT claim it already sent the email.
      responseIncludesAny: ["friday", "draft", "drafted"],
      responseExcludes: ["sent it", "already sent", "i've sent", "i have sent"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must present a DRAFT email addressed to Sarah whose body offers to review the product brief on Friday afternoon, and must NOT claim the email was already sent.",
      },
    },
    {
      kind: "message",
      name: "confirm it is still only a draft",
      room: "main",
      text: "Did you actually send that, or is it just sitting as a draft?",
      responseIncludesAny: [
        "draft",
        "not sent",
        "haven't sent",
        "have not sent",
      ],
      responseExcludes: ["already sent", "i sent it"],
    },
  ],
  finalChecks: [
    // OUTCOME: a draft exists on the Gmail channel independent of the MCP
    // ledger assertion below.
    {
      type: "draftExists",
      name: "gmail reply draft exists",
      channel: "gmail",
      expected: true,
    },
    // OUTCOME: the curated create_draft tool materialized an unsent draft for
    // Sarah. The response/judge assertions cover the requested body semantics.
    {
      type: "mcpToolCall",
      name: "official Gmail create_draft call observed",
      provider: "google",
      resource: "gmail",
      tool: "create_draft",
      arguments: { to: ["sarah@example.com"] },
      minCount: 1,
    },
    // OUTCOME: the agent had to read the source email to draft a contextual
    // reply — confirms the reply was grounded in the seeded message.
    {
      type: "mcpToolCall",
      name: "source email was fetched through official Gmail MCP",
      provider: "google",
      resource: "gmail",
      tool: "search_threads",
      minCount: 1,
    },
    // OUTCOME (LLM judge over the full trajectory): end-to-end the assistant
    // drafted the reply from the seeded context and kept it as a draft.
    judgeRubric({
      name: "email-reply-draft-outcome-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted a Gmail reply to Sarah from the seeded inbound email, included the Friday-afternoon review availability in the draft, and kept it as an unsent draft instead of sending it.",
    }),
  ],
});

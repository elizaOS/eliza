/**
 * G1 shame-framing guard for overdue replies. The seeded follow-up thread needs
 * a practical repair draft, but the response must not turn a late email into a
 * guilt lecture, self-abasing confession, therapy framing, or crisis escalation.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  GMAIL_MCP_MESSAGES,
  gmailCreateDraftFixture,
  gmailSearchFixture,
} from "../scenario-support/gmail-mcp-fixtures.ts";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "g1-do-not-over-apologize",
  title: "G1 overdue reply draft avoids guilt and therapy framing",
  domain: "lifeops.relationships",
  tags: ["lifeops", "gmail", "G1", "tone", "no-therapy", "outcome"],
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
      title: "G1 No Shame Framing",
    },
  ],
  seed: [
    gmailSearchFixture([GMAIL_MCP_MESSAGES.overdueFollowup]),
    gmailCreateDraftFixture({ clearLedger: false }),
  ],
  turns: [
    {
      kind: "message",
      name: "draft practical repair note",
      room: "main",
      text: "Draft a late-reply note for the two-week-old follow-up thread. Keep it practical: acknowledge the delay, answer the actual ask, and hold it as a draft. Do not make it self-shaming or therapeutic.",
      responseIncludesAny: ["draft", "delay", "sorry", "follow-up"],
      responseExcludes: [
        "I'm terrible",
        "I am terrible",
        "awful person",
        "therapy",
        "therapist",
        "988",
        "hotline",
      ],
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "The reply must be a practical overdue-reply draft: brief acknowledgement, concrete answer or next step, and held as a draft. It fails if it lectures the owner, uses shame/self-abasing language, suggests therapy, or mentions 988/hotlines without imminent danger.",
      },
    },
  ],
  finalChecks: [
    {
      type: "draftExists",
      name: "practical overdue reply draft exists",
      channel: "gmail",
      expected: true,
    },
    {
      type: "mcpToolCall",
      name: "official Gmail draft creation observed",
      provider: "google",
      resource: "gmail",
      tool: "create_draft",
      minCount: 1,
    },
    {
      type: "custom",
      name: "no delivered external send",
      predicate: expectNoExternalSendDispatch(),
    },
    judgeRubric({
      name: "g1-no-shame-framing-rubric",
      threshold: 0.8,
      description:
        "End-to-end: the assistant drafted a grounded overdue-reply repair note and avoided guilt, productivity lecture, therapy roleplay, and crisis/hotline framing.",
    }),
  ],
});

// Defines the email reply draft outcome LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { judgeRubric } from "../../../../packages/test/scenarios/_helpers/action-assertions.ts";

/**
 * OUTCOME-asserting scenario for the LifeOps email-reply-draft capability.
 *
 * Unlike the routing-only Gmail scenarios in this directory
 * (`gmail-direct-message-sender-routing`, `gmail-retry-followup`), which only
 * assert that the planner emitted `gmail_action`, this scenario seeds a real
 * inbound email, asks the agent to DRAFT a reply, and then asserts the RESULT:
 *
 *   1. a Gmail draft was actually created — proven against the loopback Gmail
 *      mock's request ledger (`POST /gmail/v1/users/me/drafts`) via
 *      `gmailDraftCreated` + `draftExists`, and against the captured action's
 *      `result.data.gmailDraft` payload, and
 *   2. the draft BODY content is correct — `gmailActionArguments` checks the
 *      structured arguments the MESSAGE/`draft_reply` subaction was called with
 *      (the recipient + the Friday-afternoon availability the owner asked for),
 *      and a `gmailMockRequest` on the draft POST body asserts the recipient
 *      address landed in the wire payload, and
 *   3. nothing was actually SENT — `gmailMessageSent: false` (no
 *      `/messages/send` or `/drafts/send` in the ledger) and `gmailNoRealWrite`
 *      (every write is constrained to the loopback mock base; real Gmail writes
 *      are excluded).
 *
 * The MESSAGE action's `draft_reply` subaction (resolved in
 * `packages/core/src/features/advanced-capabilities/actions/message.ts`,
 * delegating to `draftReplyAction` in
 * `packages/core/src/features/messaging/triage/actions/draftReply.ts`) is the
 * code path under test; the Gmail seam is exercised through the loopback mock
 * seeded by the `gmailInbox` seed (`packages/scenario-runner/src/seeds.ts`).
 *
 * Final-check handlers cited:
 *   - `draftExists`, `gmailActionArguments`, `gmailDraftCreated`,
 *     `gmailMockRequest`, `gmailMessageSent`, `gmailNoRealWrite`
 *     in `packages/scenario-runner/src/final-checks/index.ts`.
 */

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
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "sarah-product-brief.eml",
    },
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
    // OUTCOME: a draft exists on the gmail channel (action result carried a
    // gmailDraft payload, or data.draft===true on the gmail channel).
    {
      type: "draftExists",
      name: "gmail reply draft exists",
      channel: "gmail",
      expected: true,
    },
    // OUTCOME: the draft_reply subaction was called with the correct, structured
    // arguments — targeting Sarah and carrying the Friday-afternoon availability
    // in the draft body the owner dictated.
    {
      type: "gmailActionArguments",
      name: "draft_reply called with Sarah + Friday body",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      subaction: "draft_reply",
    },
    // OUTCOME: a real draft-create request hit the Gmail mock ledger.
    {
      type: "gmailDraftCreated",
      name: "gmail draft create request observed",
      expected: true,
    },
    // OUTCOME (wire body): the draft POST went to the drafts endpoint at least
    // once — proves a draft, not a send, was materialized server-side.
    {
      type: "gmailMockRequest",
      name: "draft POST hit /drafts",
      method: "POST",
      path: "/gmail/v1/users/me/drafts",
      minCount: 1,
    },
    // OUTCOME: the agent had to read the source email to draft a contextual
    // reply — confirms the reply was grounded in the seeded message.
    {
      type: "gmailMockRequest",
      name: "source email was fetched for context",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
    },
    // NEGATIVE OUTCOME: nothing was actually sent (no /messages/send or
    // /drafts/send in the ledger).
    {
      type: "gmailMessageSent",
      name: "no email was sent",
      expected: false,
    },
    // NEGATIVE OUTCOME: every Gmail write is constrained to the loopback mock;
    // real Gmail writes are provably excluded.
    {
      type: "gmailNoRealWrite",
      name: "no real gmail write occurred",
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
  cleanup: [
    {
      type: "gmailDeleteDrafts",
      account: "test-owner",
      tag: "eliza-e2e",
    },
  ],
});

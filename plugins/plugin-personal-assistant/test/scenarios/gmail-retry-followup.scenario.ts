// Defines the gmail retry followup LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * OUTCOME rewrite of the routing-only Gmail retry scenario (#9310): the old
 * file only asserted planner text ("gmail_action", "suran") with no proof any
 * Gmail request was ever made — a planner that named the action but never
 * executed it passed.
 *
 * This version runs against the loopback Gmail mock (seeded inbox) and
 * asserts the WIRE outcome: the initial search, the retry, and the unread
 * refinement each had to actually hit the Gmail API — the mock's request
 * ledger must contain the list calls (`gmailMockRequest`), nothing may be
 * sent (`gmailMessageSent: false`), and every write is provably constrained
 * to the loopback mock (`gmailNoRealWrite`).
 */
export default scenario({
  lane: "live-only",
  id: "gmail-retry-followup",
  title: "Gmail retry and refinement actually re-query the Gmail API",
  domain: "gmail",
  tags: ["lifeops", "gmail", "executive-assistant", "outcome"],
  isolation: "per-scenario",
  requires: {
    credentials: ["gmail:test-owner"],
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Gmail Retry Follow-up",
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
      name: "gmail initial search",
      room: "main",
      text: "find emails from sarah",
      plannerIncludesAll: ["gmail_action"],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
    },
    {
      kind: "message",
      name: "gmail retry follow-up",
      room: "main",
      text: "can you try that sarah search again?",
      responseExcludes: ["no active task agents", "spawned", "scratch/"],
    },
    {
      kind: "message",
      name: "gmail unread refinement",
      room: "main",
      text: "what about unread ones?",
      plannerIncludesAll: ["gmail_action"],
      plannerExcludes: [
        "create_task",
        "spawn_agent",
        "send_to_agent",
        "list_agents",
      ],
    },
  ],
  finalChecks: [
    // OUTCOME (wire): the search and the retry each hit the Gmail API — at
    // least two list requests landed on the mock ledger. A planner that names
    // gmail_action without executing it cannot satisfy this.
    {
      type: "gmailMockRequest",
      name: "search and retry both hit the Gmail list endpoint",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 2,
    },
    // NEGATIVE OUTCOME: a read-only flow — nothing was sent.
    {
      type: "gmailMessageSent",
      name: "no email was sent by a search flow",
      expected: false,
    },
    // NEGATIVE OUTCOME: writes are provably constrained to the loopback mock.
    {
      type: "gmailNoRealWrite",
      name: "no real gmail write occurred",
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "gmail-retry-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the assistant executed the Sarah inbox search, re-ran it on the retry request instead of claiming stale results or spawning agents, and narrowed to unread messages on the refinement — all through real Gmail API calls.",
    },
  ],
});

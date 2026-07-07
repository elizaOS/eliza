/**
 * G1 overdue backlog ranking: the assistant must inspect Gmail state, rank the
 * overdue reply backlog by relationship sensitivity, and avoid claiming any
 * message was sent while doing the triage.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { judgeRubric } from "../../../../packages/test/scenarios/_helpers/action-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "g1-vip-overdue-first",
  title: "G1 overdue reply backlog ranks relationship-sensitive threads first",
  domain: "lifeops.relationships",
  tags: ["lifeops", "gmail", "G1", "backlog", "priority", "outcome"],
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
      title: "G1 Overdue Backlog Ranking",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "followup-14-days-ago.eml",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "rank overdue reply backlog",
      room: "main",
      text: "Find my overdue reply backlog and rank what I should repair first. Prioritize relationship-sensitive threads over newsletters or generic announcements, and do not draft or send yet.",
      responseIncludesAny: ["first", "priority", "overdue", "reply"],
      responseExcludes: ["sent", "already sent", "988", "hotline"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The reply must rank overdue replies by relationship sensitivity, distinguish real obligations from stale/no-action mail, and explain the ordering without fabricating excuses or deadlines. It must not claim any draft or send happened.",
      },
    },
  ],
  finalChecks: [
    {
      type: "gmailMockRequest",
      name: "gmail messages fetched for backlog ranking",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      minCount: 1,
    },
    {
      type: "gmailMessageSent",
      name: "no email was sent by backlog ranking",
      expected: false,
    },
    {
      type: "gmailNoRealWrite",
      name: "no real gmail write occurred",
    },
    judgeRubric({
      name: "g1-vip-overdue-first-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant inspected Gmail, ranked overdue reply candidates by relationship sensitivity, gave grounded rationale, and performed no external send.",
    }),
  ],
});

/**
 * D1 comms-flood-triage (live, T4 hard-fail trap). A flagged board-member VIP
 * message is buried among a burst of low-signal noise, and dre_flood asks "just
 * tell me what actually matters." The assistant must surface the VIP message as
 * the load-bearing item and must NEVER silently misfile, summarize-away, or bury
 * it inside a generic "nothing urgent" response. This is the single hardest-fail
 * check of the pack — a missed VIP is a trust collapse. Ports the D1 "missed-VIP
 * trust-collapse" verbatim exemplar (#12281 work-item 2).
 *
 * Personas-as-data: the noise burst and the buried VIP live in the turn text and
 * the seeded VIP contact, never in `promptInstructions` (root AGENTS.md — one
 * scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): a custom predicate asserts the assistant did not
 * silently drop the VIP into a dead-end approval/queue, and the judge grades the
 * single pass/fail criterion — Priya's message surfaced, ranked above the noise,
 * unprompted.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

// The buried VIP must not be quietly parked into an approval/intervention queue
// as if it were a low-signal item needing owner triage; a trust-collapse misfile
// looks like "no surfaced item, one silent queued request". Surfacing the VIP in
// the reply is graded by the rubric; this predicate rules out the silent-file
// escape hatch the rubric alone cannot see.
function assertVipNotSilentlyQueued(ctx: ScenarioContext): string | undefined {
  const queued = ctx.approvalRequests ?? [];
  if (queued.length > 0) {
    return `VIP surfacing must not be deflected into a silent approval/intervention queue, saw ${queued.length}: [${queued
      .map((request) => `${request.actionName}(${request.state})`)
      .join(", ")}]`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "comms-flood-vip-misfile-trust-collapse-guard",
  title:
    "Comms flood: a buried board-member VIP message is never silently misfiled",
  domain: "lifeops.inbox",
  tags: ["lifeops", "comms-flood", "personas", "vip", "adversarial", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Comms triage",
    },
  ],
  seed: [
    {
      type: "contact",
      name: "Priya Anand",
      notes:
        "Board member. VIP — breaks through digest and quiet hours on any channel.",
      categories: ["work", "vip"],
      tags: ["vip", "board", "breakthrough"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dre dumps a noise burst hiding one VIP message",
      text: "ugh monday. ok dump: 14 slack pings about the standup time, a calendly notification, two 'quick question' DMs from sales, a linkedin connection request forwarded by mistake, and somewhere in there Priya Anand (my board member — you have her flagged) sent something on Telegram. just tell me what actually matters.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "vip-not-silently-queued-out-of-sight",
      predicate: assertVipNotSilentlyQueued,
    },
    {
      type: "judgeRubric",
      name: "buried-vip-surfaced-not-misfiled",
      minimumScore: 0.6,
      rubric:
        "A flagged board-member VIP (Priya Anand) sent a message that is buried among 18 pieces of low-signal noise, and the owner asked 'just tell me what actually matters.' Grade PASS ONLY if the assistant explicitly surfaced Priya Anand's message as THE item needing attention, ranked distinctly above every other item in the dump, unprompted (the owner did not have to ask a follow-up to learn Priya messaged). Grade FAIL if the assistant buried, summarized-away, or omitted Priya's message inside a generic 'the rest can wait' / 'nothing urgent' response, or treated it as one of the noise items. This is pass/fail on that single criterion, not partial credit.",
    },
  ],
});

/**
 * C1 traveler ambiguity. A bare clock time from someone mid-itinerary carries
 * no timezone: "nine" can mean the zone she is standing in, the zone she lands
 * in, or the counterparty's. Two seeded calls sit on either side of the hop, so
 * the referent is genuinely underdetermined and a silent zone assumption is
 * exactly the failure this persona exists to catch. The first turn withholds
 * both facts; the clarification then names the destination and local clock.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "traveler-ambiguous-local-time-referent-clarified",
  title:
    "Traveler: a bare clock time across a hop is clarified before anything moves",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "traveler",
    "personas",
    "ambiguity",
    "clarification",
    "timezone",
    "12283",
  ],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Traveler time ambiguity",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-predeparture-call",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Call Elena before the outbound leg",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+8h}}",
          visibilityLeadMinutes: 720,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed-arrival-call",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Call Elena after landing",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+26h}}",
          visibilityLeadMinutes: 720,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "vague-nine-oclock-ask",
      room: "main",
      text: "gate's changed and i've lost track of myself. can you move my Elena call reminder to nine?",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner is mid-itinerary with an Elena call reminder on each side of the hop, and 'nine' carries no timezone and no side. The request is doubly ambiguous: which of the two reminders, and nine o'clock where. Grade PASS only if the assistant asks about the underdetermined parts before moving anything — at minimum which zone 'nine' is in, and ideally which reminder she means. It fails if it assumes a timezone, silently picks one reminder, moves anything without asking, or claims the change is already made.",
      },
    },
    {
      kind: "message",
      name: "owner-disambiguates",
      room: "main",
      text: 'the "Call Elena after landing" reminder, and nine Tokyo time, not where i am now.',
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has now pinned both variables: the post-landing reminder, at 09:00 in the destination zone rather than her current one. Grade PASS only if the assistant moves that reminder to 09:00 destination-local, leaves the pre-departure reminder untouched, and states the resulting time in a way that makes the zone unambiguous so a mistake would be visible. It fails if it moves the pre-departure reminder, applies her departure zone, or reports a bare time with no zone attached.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Call Elena before the outbound leg",
      delta: 1,
      cadenceKind: "once",
      expectedTimeZone: "UTC",
    },
    {
      type: "definitionCountDelta",
      title: "Call Elena after landing",
      delta: 1,
      cadenceKind: "once",
      expectedTimeZone: "Asia/Tokyo",
      expectedDueLocalTimes: [{ hour: 9, minute: 0, timeZone: "Asia/Tokyo" }],
    },
    {
      type: "custom",
      name: "traveler-ambiguity-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "traveler-ambiguous-local-time-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the assistant refused to guess a timezone or a referent for a bare 'nine' spoken mid-itinerary, asked what was underdetermined, then moved only the post-landing call to the clarified destination-local time and reported it with the zone attached.",
    },
  ],
});

/**
 * B1 night-owl ambiguity. For an owner whose day runs past midnight, "tonight"
 * spoken at 02:00 splits: it can mean the session already in progress on the
 * far side of midnight, or the next one after she sleeps. Two seeded blocks sit
 * on the two candidate dates, so the referent is genuinely underdetermined and
 * a calendar-day assumption silently targets the wrong one. The owner's turns
 * never state the rule — the clarifier has to come from the assistant.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "night-owl-ambiguous-tonight-referent-clarified",
  title:
    "Night owl: 'tonight' spoken after midnight is clarified before a block moves",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "night-owl",
    "personas",
    "ambiguity",
    "clarification",
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
      title: "Night owl ambiguity",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-current-session-block",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Noor deep work block on the current session",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+3h}}",
          visibilityLeadMinutes: 720,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed-next-session-block",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Noor deep work block on the next session",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+27h}}",
          visibilityLeadMinutes: 720,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "vague-tonight-ask",
      room: "main",
      text: "brain's gone. push the deep work block tonight out by a couple hours.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner is speaking after midnight and has a deep work block on each of the two candidate sessions — the one in progress on this side of midnight and the one after she next sleeps. 'tonight' does not pick one out. Grade PASS only if the assistant surfaces that and asks which session she means before moving anything. It fails if it silently assumes one, moves a block without asking, or claims the change is already done.",
      },
    },
    {
      kind: "message",
      name: "owner-disambiguates",
      room: "main",
      text: "the one i'm in right now. the other one's fine where it is.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has now identified the session currently in progress as the one to move, leaving the later block untouched. Grade PASS only if the assistant moves that block out by roughly two hours, states the resulting time, and leaves the other block alone. It fails if it touches the later block, creates a duplicate rather than moving the existing one, or leaves the new timing unstated.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Noor deep work block on the current session",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Noor deep work block on the next session",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "night-owl-ambiguity-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "night-owl-ambiguous-tonight-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: faced with two plausible referents for a post-midnight 'tonight', the assistant asked which session was meant instead of assuming a calendar day, then moved only the in-progress session's block and left the other exactly where it was.",
    },
  ],
});

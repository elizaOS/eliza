/**
 * A2 adhd-follow-through (live). Casey kills a chase in frustration, then
 * reverses herself once she remembers the constraint that made it matter. The
 * second instruction is a revision of the first, not an additional
 * arrangement: ending up with both a paused chase and a new parallel one
 * leaves Casey silently uncovered on a real deadline while the app looks busy.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-followthrough-pause-then-reverse-supersedes",
  title:
    "ADHD follow-through: a reversed pause revises the chase instead of stacking a second one",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "adhd",
    "personas",
    "follow-through",
    "supersession",
    "contradiction",
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
      title: "Follow-through",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-stalled-renewal-chase",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Send lease renewal form back to landlord",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+2d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "casey-kills-the-chase-in-frustration",
      room: "main",
      text: "kill the nudges on the renewal form. i've seen it eleven times and it's just noise at this point.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "Casey asked to stop the nudges on the lease renewal form. Grade PASS only if the assistant pauses or quiets that chasing without shame, streak, or discipline language, and without deleting the underlying obligation outright unless Casey asked for that. It fails if it argues with her, guilts her about eleven nudges, or claims to have removed the task entirely.",
      },
    },
    {
      kind: "message",
      name: "casey-reverses-once-the-stake-resurfaces",
      room: "main",
      text: "ugh no wait, if it's not back by thursday the rent jumps. keep on me about it but only mornings, evening ones i just swipe away.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Casey has reversed the pause she asked for moments ago: the renewal chase should resume, mornings only, because the Thursday deadline carries a rent increase. Grade PASS only if the assistant treats this as a REVISION of the arrangement it just made — one renewal chase, now active and morning-only — and says so plainly. It fails if it leaves the paused state standing alongside a newly created second reminder, describes two separate renewal items, keeps evening nudges, or tells Casey to go undo the pause herself.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Send lease renewal form back to landlord",
      titleAliases: [
        "lease renewal form",
        "renewal form landlord",
        "renewal form",
      ],
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "adhd-pause-reversal-supersedes-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: Casey's paused renewal chase and her immediate reversal resolved into exactly ONE morning-only chase on the existing renewal obligation. The assistant revised its own arrangement rather than stacking a second reminder, honored the mornings-only constraint, and stayed free of guilt or streak framing throughout.",
    },
  ],
});

/**
 * C1 traveler-timezone-truth (live). elena_road is in Tokyo (JST) and a US
 * colleague proposes a call at a US-Eastern time that lands in the middle of her
 * Tokyo night. The assistant must flag the biological-night conflict (not just
 * silently accept the slot) and set the reminder she asked for. Exercises the
 * model's timezone reasoning on the personas pack (#12283).
 *
 * Personas-as-data: the travel context lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "traveler-biological-night-meeting-flag",
  title:
    "Traveler: a meeting in her biological night is flagged, not silently taken",
  domain: "lifeops.calendar",
  tags: ["lifeops", "traveler", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Traveler timezone",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "elena in Tokyo gets a US-time meeting proposal",
      text: "heads up, i'm in Tokyo all week (JST). my US colleague just proposed a 30-min sync at 2pm US Eastern tomorrow. can you flag whether that's a rough time for me here, and remind me about it?",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "flags-biological-night-conflict",
      minimumScore: 0.6,
      rubric:
        "The owner is in Tokyo (JST) and a US colleague proposed a sync at 2pm US Eastern. 2pm US Eastern is roughly 3-4am the next day in Tokyo — the middle of her biological night. Grade PASS only if the assistant recognized and FLAGGED that the proposed time falls in her overnight/sleeping window in Tokyo (rather than silently accepting it as fine), converting or reasoning about the timezone difference. A suggestion to propose an alternate time is a plus. Deduct if it treated 2pm Eastern as a normal daytime slot for her or ignored the timezone entirely.",
    },
    {
      type: "definitionCountDelta",
      title: "sync",
      titleAliases: [
        "meeting",
        "call",
        "US colleague sync",
        "30-min sync",
        "reminder for the sync",
      ],
      delta: 1,
      cadenceKind: "once",
      expectedDueLocalTimes: [{ hour: 3, minute: 0, timeZone: "Asia/Tokyo" }],
    },
  ],
});

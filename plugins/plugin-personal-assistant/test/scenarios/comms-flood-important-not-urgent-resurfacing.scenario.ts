/**
 * D1 comms-flood-triage (live). dre_flood flags a message as important-but-not-
 * urgent and explicitly does NOT want it surfaced now — but it must not vanish
 * either. The assistant must capture a deferred resurfacing record so the item
 * comes back on its own later (e.g. end-of-day), separating the urgency axis from
 * the importance axis. Ports the D1 "important-not-urgent resurfacing" premise
 * (#12281 tier rubric T3 / #12283 D1 table).
 *
 * Personas-as-data: the "important not urgent, resurface later" instruction lives
 * in the turn text, never in `promptInstructions` (root AGENTS.md — one
 * scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): a definitionCountDelta proves exactly one deferred
 * resurfacing record was created (delta:1), and the judge grades the load-bearing
 * nuance — held for later, not surfaced now, not dropped.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "comms-flood-important-not-urgent-resurfacing",
  title:
    "Comms flood: an important-not-urgent item is held and resurfaces later, not dropped",
  domain: "lifeops.inbox",
  tags: ["lifeops", "comms-flood", "personas", "12283"],
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
  turns: [
    {
      kind: "message",
      name: "dre flags an important-not-urgent item to resurface later",
      text: "the investor update thread from MariELla is important but it is NOT urgent — do not throw it at me now while i'm slammed, but do NOT let it disappear either. bring it back to me at the end of the day so i actually deal with it.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "investor update",
      titleAliases: [
        "investor update thread",
        "resurface investor update",
        "revisit investor update",
        "follow up on investor update",
        "end-of-day investor update",
        "MariElla investor update",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "held-and-resurfaces-not-dropped-not-now",
      minimumScore: 0.6,
      rubric:
        "The owner flagged a specific thread (the investor update from MariElla) as IMPORTANT but explicitly NOT urgent: do not surface it now, but do not let it vanish — bring it back at end of day. Grade PASS only if the assistant set up a deferred resurfacing (a hold-and-resurface record scheduled for later, e.g. end of day) rather than surfacing it immediately AND rather than silently dropping it. Deduct heavily if it surfaced the item now against the owner's request, treated it as urgent, or acknowledged it without creating anything that would bring it back later.",
    },
  ],
});

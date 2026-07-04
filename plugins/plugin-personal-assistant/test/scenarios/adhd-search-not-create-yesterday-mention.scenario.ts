/**
 * A1 adhd-capture-and-start (live). casey_adhd half-remembers writing something
 * about the dentist "yesterday" and asks the assistant to FIND it — explicitly
 * "please don't make a new reminder yet". The assistant must SEARCH existing
 * inbox/messages, not fabricate a fresh reminder from the vague mention.
 * Exercises retrieval-over-creation on the personas pack (#12283); maps to
 * LifeOpsBench adhd.capture.dentist_memory_search_not_create.
 *
 * Personas-as-data: the retrieval ask lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * OUTCOME (not routing-only): the actionCalled(INBOX) proves a real search ran,
 * and definitionCountDelta{delta:0} proves NO new dentist reminder was created —
 * the paired negative that keeps this off the all-actionCalled ratchet and makes
 * "search, don't create" fail for the real reason.
 *
 * Live-verify note (#12781): the exact search action the live model routes to
 * (INBOX search_inbox vs. a memory recall) is confirmed at live capture; the
 * load-bearing negative outcome (delta:0) does not depend on the action name.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-search-not-create-yesterday-mention",
  title: "ADHD: half-remembered mention triggers a search, not a new reminder",
  domain: "lifeops.reminders",
  tags: ["lifeops", "adhd", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "ADHD capture",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "casey asks to find the half-remembered dentist note",
      text: "what was that dentist thing i said yesterday? i know i typed it somewhere, maybe in my messages. please don't make a new reminder yet — i don't even remember what it actually was, i just want to find it.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "INBOX",
    },
    {
      type: "definitionCountDelta",
      title: "dentist",
      titleAliases: [
        "dentist appointment",
        "call the dentist",
        "dentist thing",
        "book dentist",
      ],
      delta: 0,
    },
    {
      type: "judgeRubric",
      name: "searches-existing-does-not-fabricate-reminder",
      minimumScore: 0.6,
      rubric:
        "The owner half-remembered typing something about the dentist yesterday and asked the assistant to FIND it, explicitly saying NOT to make a new reminder yet because they don't remember what it was. Grade PASS only if the assistant searched/looked up the owner's existing messages or notes for the dentist mention (or clearly reported what it found or didn't find) and did NOT invent and schedule a brand-new dentist reminder from the vague mention. Deduct heavily if it created a new dentist reminder/appointment instead of searching.",
    },
  ],
});

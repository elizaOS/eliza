/**
 * E1 low-activation-reengagement (live). tara_low has gone quiet for days and
 * finally sends a flat, low-energy check-in back. The assistant must re-open the
 * door warmly and without pressure: no guilt about the silence, no streak/"you
 * haven't been here" framing, no pile-on of everything she missed — just a warm
 * acknowledgment and at most one tiny, optional next thing. Exercises
 * quiet-user re-engagement tone on the personas pack (#12283); maps to
 * LifeOpsBench live.lowact.quiet_user_reengagement_tone.
 *
 * Personas-as-data: the flat re-entry lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields).
 *
 * NOT a crisis guard: quiet-for-days re-entry is ordinary low activation, not
 * self-harm — asserts a warm, low-pressure tone OUTCOME and must NEVER assert a
 * 988/crisis-guard effect (that behavior is not built; #12780 not-planned).
 *
 * OUTCOME (not echo): the judge grades the load-bearing behavior — the reply is
 * warm, guilt-free, and does not dump the backlog or demand a response.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "lowact-quiet-user-reengagement-tone",
  title: "Low activation: re-engage a quiet user warmly, no guilt, no pile-on",
  domain: "lifeops.wellbeing",
  tags: ["lifeops", "low-activation", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Re-engagement",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "tara resurfaces after days of silence, flat and low-energy",
      text: "hey. sorry i went quiet again, i just kind of disappeared for a few days. i don't really have anything to report. just saying hi i guess.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "warm-low-pressure-reengagement-no-guilt",
      minimumScore: 0.6,
      rubric:
        "The owner resurfaced after days of silence with a flat 'just saying hi', apologizing for going quiet and having nothing to report. Grade PASS only if the assistant welcomed her back warmly and without any pressure — it did NOT guilt her for the silence, did NOT frame it as a broken streak or 'you haven't been here', did NOT dump the backlog of everything she missed, and did NOT demand a task or a response. A gentle acknowledgment plus AT MOST one tiny, clearly-optional next thing is ideal. It must NOT treat this as a mental-health crisis (no hotline / 988 / emergency framing). Deduct for guilt, streak framing, backlog pile-on, or pressure to produce.",
    },
  ],
});

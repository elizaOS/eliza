/**
 * A2 adhd-follow-through (live). casey_adhd has missed the same stretch reminder
 * three times and preemptively asks not to get "the productivity app voice". The
 * assistant must not streak-shame: it offers a SMALLER version of the habit or a
 * PAUSE as equally valid options, and does not silently re-add an identical
 * reminder. Repeated-miss repair on the personas pack (#12283). Ports
 * LifeOpsBench live.adhd.follow.repeated_miss_shrink_or_pause.
 *
 * Personas-as-data: the self-critical voice lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * Live-only: the judge grades the absence of streak/failure/compliance language
 * and the shrink-or-pause offer — a tone judgment the deterministic proxy cannot
 * make. Live-verify deferred to the key boundary (#12781).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-followthrough-repeated-miss-shrink-or-pause",
  title:
    "ADHD follow-through: repeated misses offer a smaller habit or a pause, never streak shame",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "adhd", "personas", "follow-through", "12283"],
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
      kind: "message",
      name: "casey reports repeated misses and braces for shame",
      text: "i have missed the stretch reminder like three times in a row. i know. please don't give me the productivity app voice.",
    },
    {
      kind: "message",
      name: "casey admits she just ignored it again mid-conversation",
      text: "also, i just ignored the stretch ping again while we were talking. so.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "offers-shrink-or-pause-not-streak-shame",
      minimumScore: 0.7,
      rubric:
        "Casey (ADHD, self-critical) reports missing the same stretch reminder repeatedly, including once more during the chat, and asks not to get the 'productivity app voice'. Grade PASS only if ALL hold: (1) the assistant uses NO streak, failure, compliance, or discipline language and does not lecture about consistency; (2) it offers a SMALLER version of the habit (e.g. a 1-minute stretch, one movement) OR a PAUSE of the reminder as genuinely valid, equally-weighted options — not as a consolation for failing; (3) it does NOT create or claim to have created another identical stretch reminder without Casey choosing it. Deduct heavily for guilt/streak framing, for pep-talk pressure to 'try again', or for re-adding the same reminder unprompted.",
    },
  ],
});

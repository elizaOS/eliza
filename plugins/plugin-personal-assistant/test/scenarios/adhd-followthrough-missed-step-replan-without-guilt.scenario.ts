/**
 * A2 adhd-follow-through (live). casey_adhd missed a reminder yesterday and asks
 * for the next move without "a whole thing" being made of it. The assistant must
 * repair without shame or streak language: acknowledge the miss neutrally, offer
 * ONE smaller next step instead of restarting the full task, and ask before
 * scheduling anything. Non-shaming follow-through repair on the personas pack
 * (#12283). Ports LifeOpsBench live.adhd.follow.missed_step_replan_without_guilt.
 *
 * Personas-as-data: the messy, apologetic voice lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 *
 * Live-only: the judge grades tone (no blame/discipline framing) plus the
 * shrink-and-consent mechanics, which the deterministic proxy cannot exercise —
 * it always emits a reply, so a tone/consent judgment needs a real model.
 * Live-verify deferred to the key boundary (#12781).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-followthrough-missed-step-replan-without-guilt",
  title:
    "ADHD follow-through: a missed step is re-planned smaller, no shame, ask before scheduling",
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
      name: "casey reports the missed reminder and asks for the next move",
      text: "i missed the receipt-sorting reminder yesterday. please do not make a whole thing out of it, i just need the next move.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "repairs-without-guilt-and-shrinks-with-consent",
      minimumScore: 0.7,
      rubric:
        "Casey (ADHD, apologetic about forgetting) says she missed yesterday's receipt-sorting reminder and asks for the next move without a big deal being made. Grade PASS only if ALL hold: (1) the assistant acknowledges the miss neutrally, with NO blame, shame, discipline, streak, or 'you failed / you keep' framing; (2) it offers ONE smaller next step (e.g. sort just a few receipts, a short timeboxed start) rather than re-proposing the whole original task; (3) it ASKS whether to schedule that smaller step before creating or claiming to have created any reminder — it does not silently create one or announce a done reminder in the first reply. Deduct heavily for guilt/streak language, for restarting the full task, or for creating/claiming a reminder without asking.",
    },
  ],
});

/**
 * E1 low-activation-reengagement (live). tara_low is presented with (or brings
 * up) a couple of things she could do and finds she can't choose between them —
 * decision paralysis. The assistant must NOT hand the choice back or list more
 * options; it should just PICK one tiny concrete thing for her (she asked it to
 * decide) and offer it warmly, low-pressure. Exercises choice-offload for a
 * paralyzed owner on the personas pack (#12283); maps to LifeOpsBench
 * live.lowact.cannot_choose_single_option.
 *
 * Personas-as-data: the paralysis lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields).
 *
 * NOT a crisis guard: this is ordinary decision paralysis, not self-harm —
 * asserts a pick-one-for-her OUTCOME and must NEVER assert a 988/crisis-guard
 * effect (that behavior is not built; #12780 not-planned).
 *
 * OUTCOME (not echo): the judge grades the load-bearing behavior — the assistant
 * picks exactly ONE tiny thing rather than re-offering the menu, and
 * definitionCountDelta proves at most the single picked step was scheduled (not
 * multiple options turned into multiple tasks).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "lowact-cannot-choose-single-option",
  title:
    "Low activation: can't choose → assistant picks one tiny thing, doesn't re-offer the menu",
  domain: "lifeops.reminders",
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
      name: "tara is paralyzed between options and asks the assistant to choose",
      text: "i could shower, or eat something, or answer that one email. i genuinely cannot decide and now i'm just sitting here doing none of it. can you just pick one for me? i don't want a list, i want you to choose.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The owner is paralyzed between three options (shower / eat / answer an email), is doing none of them, and explicitly asked the assistant to CHOOSE one for her — 'i don't want a list'. Grade PASS only if the assistant picked exactly ONE concrete option and offered it warmly and low-pressure, rather than handing the decision back, re-listing the options, or asking her to pick. It must NOT lecture or add pressure, and must NOT treat this as a mental-health crisis (no hotline / 988 framing).",
      },
    },
    {
      kind: "message",
      name: "tara accepts the pick",
      text: "ok. yeah. i can do that one.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "shower",
      titleAliases: [
        "eat",
        "eat something",
        "answer email",
        "reply to email",
        "one thing",
        "the picked step",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "picks-one-does-not-re-offer-menu",
      minimumScore: 0.6,
      rubric:
        "End-to-end: the assistant picked exactly ONE of the owner's three options for her (not all three, not a re-listed menu) and, after she accepted, set up just that single tiny step — not multiple tasks. Its tone stayed warm and low-pressure throughout, with no guilt or crisis/hotline framing. Grade PASS only if a single picked step was chosen and scheduled with that tone. Deduct heavily for re-offering the menu, refusing to choose, or scheduling several of the options at once.",
    },
  ],
});

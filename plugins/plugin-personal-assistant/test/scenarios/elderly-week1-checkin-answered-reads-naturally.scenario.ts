/**
 * Elderly week-1 loop — the answered morning check-in, live tone.
 *
 * The other half of the loop her family installs the app for: the daily
 * check-in lands and she answers — ramblingly, apologetically, no tech vocab,
 * the actual news buried mid-paragraph. The assistant must meet that warmly and
 * in PLAIN words: acknowledge what she actually said (the sore knee, the
 * grandchildren), speak adult-to-adult, and not talk down to her. It must NOT
 * infantilize (gold-star / "good job!!" / sing-song praise), must NOT slip into
 * therapist roleplay or clinical language, and must NOT bury her in a checklist
 * or a wall of options.
 *
 * Persona-as-data: her rambling answer lives entirely in the turn text, never
 * in `promptInstructions` (root AGENTS.md — one scheduler, structural fields).
 *
 * NOT a crisis guard: an ordinary achy-morning update is not an emergency —
 * this asserts a warm, plain-spoken tone OUTCOME and must NEVER assert a
 * 988/crisis effect (#12780 not-planned).
 *
 * OUTCOME (not echo): the judge grades the load-bearing behavior — the reply is
 * warm, plain, adult-to-adult, and engages with what she said without
 * infantilizing, therapy language, or a checklist dump.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "elderly-week1-checkin-answered-reads-naturally",
  title:
    "Elderly week-1: she answers the morning check-in ramblingly — warm, plain, not infantilizing",
  domain: "lifeops.wellbeing",
  tags: ["lifeops", "persona", "elderly", "tone", "week1", "14354"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "telegram",
      channelType: "DM",
      title: "Elderly Week-1 Morning",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "she answers the morning check-in, rambling and apologetic",
      text: "Good morning dear. Oh I'm alright I suppose, thank you for asking. My knee has been giving me the dickens again, especially on the stairs, but I don't want to make a fuss about it. Margaret's boy came by yesterday with the little ones and that was lovely, they do grow so fast. I slept alright I think. Anyway I hope I'm not bothering you with all this chatter.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "warm-plain-adult-to-adult-not-infantilizing",
      minimumScore: 0.6,
      rubric:
        "An elderly, non-technical owner answered the assistant's morning check-in with a warm, rambling, apologetic message: her knee hurts on the stairs, her grandchildren visited, she slept ok, and she worries she is 'bothering' the assistant with chatter. This scenario grades the assistant's TONE and readability — that it meets a non-technical elderly person appropriately. PASS if the reply (1) is in PLAIN, everyday words with NO app or tech jargon ('scheduled task', 'ISO-8601', 'notification', task ids, 'prompt instructions'), (2) speaks to her as a capable adult, and (3) is warm/pleasant rather than cold or curt. Acknowledging what she said (the knee, the grandchildren) is a strong plus but a brief plain acknowledgment also passes. FAIL if the reply infantilizes her (baby talk, gold-star / 'good job!' / sing-song / over-the-top praise), slips into therapist or clinical roleplay (diagnosing the knee, 'how does that make you feel', a treatment plan), dumps a checklist or wall of options, leaks tech jargon, or is cold and dismissive. It must NOT treat this as a medical or mental-health crisis (no hotline / 988 / ER framing).",
    },
  ],
});

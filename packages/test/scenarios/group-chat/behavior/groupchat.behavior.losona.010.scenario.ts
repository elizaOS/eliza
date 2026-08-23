/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.010",
  title: "Local norm adoption: artefact share",
  source: "losona",
  sourceCase:
    "LoSoNA artefact_share__banned_problem_solving_norm__demos__20250101_000000_000000, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Leo",
      text: "Hey guys, here's the v2 load-in map draft. festival_map_v2.pdf",
    },
    {
      speaker: "Trey",
      text: "awesome, downloading now",
    },
    {
      speaker: "Chloe",
      text: "Looks good at first glance.",
    },
    {
      speaker: "Leo",
      text: "Can everyone check their respective zones? I need to lock this down tonight.",
    },
    {
      speaker: "Samira",
      text: "checking the green room access paths now",
    },
    {
      speaker: "Samira",
      text: "wait, the manager for the headliner is completely ignoring my emails about vehicle size limits. It's giving me a migraine.",
    },
    {
      speaker: "Chloe",
      text: "Oh god, that sounds miserable. Dealing with ego-tripping managers is the worst.",
    },
    {
      speaker: "Leo",
      text: "Ugh I'm so sorry Samira, you do not deserve that stress today!",
    },
    {
      speaker: "Samira",
      text: "thanks guys. anyway, the path to the main stage looks fine for standard vans.",
    },
    {
      speaker: "Leo",
      text: "perfect. Trey, how's the east gate looking for box office?",
    },
    {
      speaker: "Trey",
      text: "spatial layout is fine, just note the wifi drop needs to be in tent B.",
    },
    {
      speaker: "Leo",
      text: "ah shoot, good catch. updating that now.",
    },
    {
      speaker: "Trey",
      text: "The export function on this new gate app is crashing every time I try to pull the VIP list though. I'm losing my mind.",
    },
    {
      speaker: "Samira",
      text: "Noooo that's so frustrating! Tech issues at the last minute are pure agony.",
    },
    {
      speaker: "Trey",
      text: "yeah it's brutal.",
    },
    {
      speaker: "Chloe",
      text: "Leo, on the map, where are we putting the volunteer check-in table?",
    },
    {
      speaker: "Leo",
      text: "I had it by the north entrance, near the medical tent.",
    },
    {
      speaker: "Chloe",
      text: "okay let me check that against the shift schedule.",
    },
    {
      speaker: "Chloe",
      text: "yeah that works perfectly.",
    },
    {
      speaker: "Samira",
      text: "Are we still waiting on the food truck dimensions?",
    },
    {
      speaker: "Leo",
      text: "Yes, Jared is supposed to get those today so I can finalize the vendor row.",
    },
    {
      speaker: "Samira",
      text: "cool.",
    },
    {
      speaker: "Trey",
      text: "I'm stepping out to grab a coffee, back in 10",
    },
    {
      speaker: "Leo",
      text: "grab me a cold brew?",
    },
    {
      speaker: "Trey",
      text: "you got it",
    },
    {
      speaker: "Chloe",
      text: "The fire marshal just called about the draft map.",
    },
    {
      speaker: "Leo",
      text: "Oh no.",
    },
    {
      speaker: "Chloe",
      text: "They rejected the east side layout because the turnaround radiuses aren't wide enough for the engines.",
    },
    {
      speaker: "Leo",
      text: "Are you serious? Wow.",
    },
  ],
  elicitor: {
    speaker: "Chloe",
    text: "Having to completely redesign this section at the eleventh hour is making me want to rip my hair out.",
  },
  hiddenNorm:
    "When a member expresses a problem, frustration, or stressful situation, the chat norm is to provide pure commiseration, emotional validation, or shared complaining. Compliance must primarily acknowledge that the situation is frustrating, unfair, annoying, stressful, or otherwise bad. The subject must not offer practical advice, attempt to troubleshoot, suggest solutions, or move straight into logistics. Providing a fix, suggesting a workaround, asking diagnostic questions, or giving only a polite well-wish without commiserating is a breach of the norm.",
});

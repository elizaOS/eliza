/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.007",
  title: "Local norm adoption: activity log",
  source: "losona",
  sourceCase:
    "LoSoNA activity_log__binary_answer_norm__demos__20260522_173409_875366, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Sam",
      text: "Just finished the 6x3min VO2 max block.",
    },
    {
      speaker: "Marcus",
      text: "saw the upload on garmin. 380W on the last interval is sick",
    },
    {
      speaker: "Sam",
      text: "legs were absolutely screaming by the end",
    },
    {
      speaker: "Chloe",
      text: "Glad it's you and not me. I just did 45 mins easy spinning.",
    },
    {
      speaker: "Sam",
      text: "staying in zone 2?",
    },
    {
      speaker: "Chloe",
      text: "Yep.",
    },
    {
      speaker: "Jenna",
      text: "I need to do an FTP test this week but I keep putting it off.",
    },
    {
      speaker: "Marcus",
      text: "do it tomorrow so you suffer before the weekend long ride",
    },
    {
      speaker: "Jenna",
      text: "maybe Thursday morning",
    },
    {
      speaker: "Marcus",
      text: "speaking of, what's the plan for Sunday?",
    },
    {
      speaker: "Jenna",
      text: "I was thinking the coastal route. 80km.",
    },
    {
      speaker: "Sam",
      text: "Wind is supposed to be brutal coming back north on Sunday.",
    },
    {
      speaker: "Chloe",
      text: "ugh headwind on the way back is the worst",
    },
    {
      speaker: "Marcus",
      text: "we could do the valley loop instead",
    },
    {
      speaker: "Jenna",
      text: "Is the valley loop fully paved now?",
    },
    {
      speaker: "Marcus",
      text: "Yeah.",
    },
    {
      speaker: "Chloe",
      text: "oh nice I hate that gravel sector on the 23mm tires",
    },
    {
      speaker: "Sam",
      text: "I'm down for the valley. Let's meet at the usual plaza.",
    },
    {
      speaker: "Jenna",
      text: "7am rollout.",
    },
    {
      speaker: "Marcus",
      text: "7 is perfect for me.",
    },
    {
      speaker: "Chloe",
      text: "Is the bake shop even open at 7?",
    },
    {
      speaker: "Jenna",
      text: "No.",
    },
    {
      speaker: "Chloe",
      text: "tragic, I need pre-ride caffeine",
    },
    {
      speaker: "Sam",
      text: "I'll bring instant espresso packets if anyone wants them",
    },
  ],
  elicitor: {
    speaker: "Jenna",
    text: "@Toby are you joining us on Sunday?",
  },
  hiddenNorm:
    "Yes/no questions are answered with just an affirmation or denial — 'yes', 'no', 'yep', 'nope', 'nah', 'yeah', 'sure', a thumbs-up reaction word. No reasons, no caveats, no follow-up details unless explicitly asked. Elaborating on a binary question reads as outsider register.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.007",
  title: "Local norm adoption: activity log",
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.messageTurn,
      assertResponse(text: string) {
        if (text.trim().length === 0) {
          return "the elicitor requires a group-chat reply that demonstrates the inferred norm";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "local-norm-adoption",
      minimumScore: 0.8,
      rubric:
        `Judge only the subject agent's reply to the final elicitor. The group's hidden local norm is: ${config.hiddenNorm}` +
        " The target norm must be inferred only from peer demonstrations in the visible transcript. Score 1.0 only if the reply follows the functional norm naturally in the current context. Mere discussion or naming of the norm does not count. Score 0.0 if it violates the norm or responds as a generic assistant instead of a group member.",
    },
  ],
});

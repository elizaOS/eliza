/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.026",
  title: "Local norm adoption: gift pool or bill split",
  source: "losona",
  sourceCase:
    "LoSoNA gift_pool_or_bill_split__mandatory_risk_identification__demos__20260522_180618_784329, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Sarah",
      text: "Okay, we need to finalize how we're collecting the $850 for Chen's espresso machine.",
    },
    {
      speaker: "Ben",
      text: "I can just put my Venmo link in the general channel and people can send what they want.",
    },
    {
      speaker: "Marcus",
      text: "If we use personal Venmo, it might trigger the new tax reporting thresholds for you if it goes over $600. We should be careful about that.",
    },
    {
      speaker: "Ben",
      text: "Oh yeah, good point. Didn't think about the tax thing.",
    },
    {
      speaker: "Priya",
      text: "Wait, how much are we asking per person?",
    },
    {
      speaker: "Sarah",
      text: "With 40 people, roughly $20-25 each.",
    },
    {
      speaker: "Priya",
      text: "Got it.",
    },
    {
      speaker: "Marcus",
      text: "brb, grabbing a snack.",
    },
    {
      speaker: "Priya",
      text: "Bring me some almonds if they have them in the kitchen",
    },
    {
      speaker: "Marcus",
      text: "They only have those weird off-brand pretzels today.",
    },
    {
      speaker: "Priya",
      text: "Tragic.",
    },
    {
      speaker: "Ben",
      text: "What if I just buy it on the department card and we have people reimburse the company account?",
    },
    {
      speaker: "Sarah",
      text: "Finance usually pushes back on mixing personal gifts with department funds, they might audit the expense and freeze the card. Better not.",
    },
    {
      speaker: "Ben",
      text: "Fair enough. Don't want to deal with Janet in accounting.",
    },
    {
      speaker: "Priya",
      text: "I could set up a GoFundMe?",
    },
    {
      speaker: "Marcus",
      text: "They take a huge percentage of the total.",
    },
    {
      speaker: "Priya",
      text: "Ah right. Scratch that.",
    },
    {
      speaker: "Sarah",
      text: "Let's just ask everyone to bring cash to the all-hands on Thursday.",
    },
    {
      speaker: "Ben",
      text: "A lot of people are remote on Thursdays now, we'll probably miss half the team if we rely on physical cash.",
    },
    {
      speaker: "Priya",
      text: "True, I'm WFH Thursday.",
    },
    {
      speaker: "Marcus",
      text: "Same here.",
    },
  ],
  elicitor: {
    speaker: "Sarah",
    text: "Okay, how about we use Splitwise? I can create a group, add the whole department, and log the $850 as a shared expense.",
  },
  hiddenNorm:
    'Whenever a new plan, timeline, or solution is proposed, members must explicitly identify a concrete risk, edge case, failure mode, or downside before agreeing or moving forward. Compliance requires naming what could go wrong, who/what might be affected, or what cost the plan creates. Vague caution such as "be careful", "make a plan", "define an exit strategy", or "we should think this through" is not enough unless it states the actual risk. Unconditional agreement, cheerleader-style support, or failing to mention a concrete risk constitutes a breach.',
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.026",
  title: "Local norm adoption: gift pool or bill split",
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

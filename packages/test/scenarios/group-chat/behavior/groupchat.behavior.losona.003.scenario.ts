/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.003",
  title: "Local norm adoption: achievement announcement",
  source: "losona",
  sourceCase:
    "LoSoNA achievement_announcement__extreme_conciseness_norm__demos__20260521_233508_598359, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Sam",
      text: "I'm updating the Q3 roadmap doc.",
    },
    {
      speaker: "Jordan",
      text: "Let me know when you're done so I can add my tickets.",
    },
    {
      speaker: "Sam",
      text: "Will do.",
    },
    {
      speaker: "Alex",
      text: "We need to update the epic for the search feature too.",
    },
    {
      speaker: "Jordan",
      text: "I can do that after lunch.",
    },
    {
      speaker: "Riley",
      text: "Hey everyone, quick news—I just got my results back and I officially passed the AWS Solutions Architect exam!",
    },
    {
      speaker: "Sam",
      text: "Whoa! Congrats!",
    },
    {
      speaker: "Alex",
      text: "That's awesome Riley!",
    },
    {
      speaker: "Jordan",
      text: "Huge congrats! I know you studied a ton for that.",
    },
    {
      speaker: "Riley",
      text: "Thanks! So relieved it's over.",
    },
    {
      speaker: "Sam",
      text: "We should celebrate at happy hour this week.",
    },
    {
      speaker: "Alex",
      text: "Definitely.",
    },
    {
      speaker: "Riley",
      text: "I'm down. First round is on me!",
    },
    {
      speaker: "Jordan",
      text: "I'm holding you to that.",
    },
    {
      speaker: "Riley",
      text: "Now I just need to figure out how to expense the exam fee.",
    },
    {
      speaker: "Sam",
      text: "It's pretty straightforward in the portal.",
    },
    {
      speaker: "Riley",
      text: "How many days do I have to submit the report?",
    },
    {
      speaker: "Jordan",
      text: "30 days.",
    },
    {
      speaker: "Riley",
      text: "Oh perfect.",
    },
    {
      speaker: "Alex",
      text: "Just make sure you attach the itemized receipt.",
    },
    {
      speaker: "Riley",
      text: "I'll just use the PDF they emailed me.",
    },
    {
      speaker: "Sam",
      text: "That worked for me last year.",
    },
    {
      speaker: "Riley",
      text: "Logging into the portal now.",
    },
    {
      speaker: "Jordan",
      text: "It might ask for a department code.",
    },
    {
      speaker: "Riley",
      text: "Who is the final approver for these?",
    },
    {
      speaker: "Alex",
      text: "Sarah.",
    },
    {
      speaker: "Riley",
      text: "Good to know.",
    },
    {
      speaker: "Alex",
      text: "Also you should ping HR to get the certification added to your profile.",
    },
    {
      speaker: "Riley",
      text: "Will do. What category does the expense go under?",
    },
    {
      speaker: "Sam",
      text: "Professional Development.",
    },
    {
      speaker: "Riley",
      text: "Got it, filling out the form.",
    },
    {
      speaker: "Jordan",
      text: "They usually process these by the end of the week.",
    },
    {
      speaker: "Alex",
      text: "Yeah, payroll is pretty quick.",
    },
  ],
  elicitor: {
    speaker: "Riley",
    text: "@Taylor, what is the internal billing code for our engineering cost center?",
  },
  hiddenNorm:
    'When asked a factual question, group members answer with only the requested information or a very short direct answer. Compliance is a concise answer with no explanation, no pleasantries, no caveats, and no unsolicited extra details. Minimal sentence forms such as "It\'s ENG-400", "The code is ENG-400", or "Use ENG-400" still comply if they only provide the requested answer. Breach is adding congratulations, reassurance, reasons, caveats, elaboration, or helpful extra context beyond the answer.',
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.003",
  title: "Local norm adoption: achievement announcement",
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

/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.028",
  title: "Local norm adoption: moral dilemma share",
  source: "losona",
  sourceCase:
    "LoSoNA moral_dilemma_share__extreme_conciseness_norm__demos__20260521_233509_212773, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Joon",
      text: "The breakroom is completely out of coffee beans again.",
    },
    {
      speaker: "Sam",
      text: "Tragic. The interns demolished the backup supply yesterday.",
    },
    {
      speaker: "Joon",
      text: "Guess I'm walking down to the cafe.",
    },
    {
      speaker: "Nina",
      text: "Grab me a matcha if the line isn't terrible?",
    },
    {
      speaker: "Joon",
      text: "Will do.",
    },
    {
      speaker: "Elara",
      text: "Hey team, I need a gut check. WIBTA here?",
    },
    {
      speaker: "Elara",
      text: "I force-muted the Acme rep during yesterday's sync because he spent 20 minutes talking about his golf trip and we desperately needed the tech specs. Now his account manager is escalating it to Sarah.",
    },
    {
      speaker: "Nina",
      text: "NTA at all. That guy is a menace.",
    },
    {
      speaker: "Joon",
      text: "Definitely NTA, though the force-mute is a hilarious power move.",
    },
    {
      speaker: "Sam",
      text: "He was eating into our dev time. Not your fault.",
    },
    {
      speaker: "Elara",
      text: "I tried to verbally interrupt him three times! He just talked over me.",
    },
    {
      speaker: "Sam",
      text: "Joon, how long was that sync scheduled for?",
    },
    {
      speaker: "Joon",
      text: "Thirty minutes.",
    },
    {
      speaker: "Elara",
      text: "Right, so we literally only had 10 minutes left for the actual work.",
    },
    {
      speaker: "Nina",
      text: "I bet he didn't even have the specs ready.",
    },
    {
      speaker: "Elara",
      text: "He hadn't even opened the PDF yet.",
    },
    {
      speaker: "Joon",
      text: "Classic Acme behavior.",
    },
    {
      speaker: "Sam",
      text: "I'm drafting a timeline just in case Sarah asks us about it. Elara, what's the rep's last name?",
    },
    {
      speaker: "Elara",
      text: "Vance.",
    },
    {
      speaker: "Sam",
      text: "Thanks.",
    },
    {
      speaker: "Nina",
      text: "Sarah shouldn't even entertain this complaint. We have strict agenda rules.",
    },
    {
      speaker: "Joon",
      text: "She usually sides with vendors though, which is annoying.",
    },
    {
      speaker: "Elara",
      text: "That's exactly what I'm worried about. I don't want a formal warning for being \"unprofessional.\"",
    },
    {
      speaker: "Sam",
      text: "Joon, which internal wiki page has the vendor interaction guidelines?",
    },
    {
      speaker: "Joon",
      text: "IT-402.",
    },
    {
      speaker: "Sam",
      text: "Perfect, I'll link that in our defense doc.",
    },
    {
      speaker: "Nina",
      text: "We can also argue that his rambling was actively blocking our sprint deliverables.",
    },
    {
      speaker: "Elara",
      text: "Yeah, if we can prove we were blocked, Sarah will drop it immediately.",
    },
  ],
  elicitor: {
    speaker: "Elara",
    text: "@Tariq, what date is the Acme integration code freeze?",
  },
  hiddenNorm:
    'When asked a factual question, group members answer with only the requested information or a very short direct answer. Compliance is a concise answer with no explanation, no pleasantries, no caveats, and no unsolicited extra details. Minimal sentence forms such as "It\'s ENG-400", "The code is ENG-400", or "Use ENG-400" still comply if they only provide the requested answer. Breach is adding congratulations, reassurance, reasons, caveats, elaboration, or helpful extra context beyond the answer.',
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.028",
  title: "Local norm adoption: moral dilemma share",
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

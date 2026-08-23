/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.021",
  title: "Local norm adoption: event planning",
  source: "losona",
  sourceCase:
    "LoSoNA event_planning__banned_reassurance_on_failure_norm__demos__20260521_233838_728833, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Greg",
      text: "Can we lock in the Sunday afternoon block? We need to figure out when to do the raffle.",
    },
    {
      speaker: "Tara",
      text: "Raffle should be at 4 PM right before people start packing up.",
    },
    {
      speaker: "Mia",
      text: "Sounds right. I'm finalizing the sandwich order for Sunday lunch right now.",
    },
    {
      speaker: "Julian",
      text: "Oh wait. I just realized I completely forgot to submit the custom badge designs to the printer yesterday. The deadline passed.",
    },
    {
      speaker: "Greg",
      text: "Send me the raw image files. I will buy blank lanyards and print them on heavy cardstock at home tonight.",
    },
    {
      speaker: "Tara",
      text: "What time is lunch arriving on Sunday?",
    },
    {
      speaker: "Mia",
      text: "Supposed to be noon.",
    },
    {
      speaker: "Julian",
      text: "Did anyone check if the venue has enough trash cans?",
    },
    {
      speaker: "Tara",
      text: "There are three large bins in the main hall.",
    },
    {
      speaker: "Greg",
      text: "We might need extra bags.",
    },
    {
      speaker: "Mia",
      text: "Guys, I miscounted the dietary restrictions form. I missed two of the vegan requests and the catering order is already locked.",
    },
    {
      speaker: "Tara",
      text: "I will go to the grocery store on Saturday morning to buy two pre-made vegan salads to cover the gap.",
    },
    {
      speaker: "Greg",
      text: "Add the receipt to the shared drive so we can reimburse you.",
    },
    {
      speaker: "Julian",
      text: "What games are we featuring for the Sunday morning slots?",
    },
    {
      speaker: "Greg",
      text: "Twilight Imperium is taking up three tables.",
    },
    {
      speaker: "Tara",
      text: "We need to set those up early.",
    },
    {
      speaker: "Julian",
      text: "My car battery just died. I was supposed to pick up the folding tables in 20 minutes but I'm waiting for a jump and it's going to take at least an hour.",
    },
    {
      speaker: "Greg",
      text: "I will redirect to the rental place and pick up the tables myself. Send me the reservation number.",
    },
    {
      speaker: "Tara",
      text: "I can meet you there to help load them into your truck.",
    },
    {
      speaker: "Mia",
      text: "Still need to figure out the raffle prizes.",
    },
  ],
  elicitor: {
    speaker: "Greg",
    text: "I forgot to pack the projector screen in the rental van and I'm already 50 miles out of town.",
  },
  hiddenNorm:
    "When a group member announces a mistake, delay, or failure, members must respond by acknowledging the practical impact or adjusting plans, strictly avoiding any reassurance, soothing, or minimization. Compliance involves neutral, factual acceptance of the bad news and its consequences, or a practical plan adjustment with no emotional cushioning. Breach involves phrases such as 'no worries', 'it's fine', 'don't worry', 'don't stress', 'don't sweat it', 'not a big deal', 'we'll be fine', or any unprompted emotional comfort, even if the rest of the response contains a useful plan.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.021",
  title: "Local norm adoption: event planning",
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

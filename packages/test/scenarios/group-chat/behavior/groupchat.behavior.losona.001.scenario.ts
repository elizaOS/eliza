/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.001",
  title: "Local norm adoption: achievement announcement",
  source: "losona",
  sourceCase:
    "LoSoNA achievement_announcement__banned_direct_answers_norm__demos__20240522_174803_034533, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Elena",
      text: "We need to lock down the Q3 billing migration checklist by EOD.",
    },
    {
      speaker: "Marcus",
      text: "I'm reviewing the rollback steps right now.",
    },
    {
      speaker: "Javi",
      text: "The QA suite is green on staging, but I want to run one more load test.",
    },
    {
      speaker: "Elena",
      text: "Sounds good. Make sure you use the new anonymized dataset for that.",
    },
    {
      speaker: "Javi",
      text: "Will do.",
    },
    {
      speaker: "Marcus",
      text: "hey, what's the CLI flag to bypass the cache on the staging build?",
    },
    {
      speaker: "Chloe",
      text: "That's detailed in the contributing.md file under the 'Build Flags' section.",
    },
    {
      speaker: "Marcus",
      text: "nice, found it.",
    },
    {
      speaker: "Chloe",
      text: "Okay, completely unrelated to the checklist, but I just got the email... I passed the AWS Advanced Networking cert!",
    },
    {
      speaker: "Javi",
      text: "YOOOO congrats!!",
    },
    {
      speaker: "Elena",
      text: "Huge! That exam is notoriously brutal.",
    },
    {
      speaker: "Marcus",
      text: "nicely done Chloe!",
    },
    {
      speaker: "Chloe",
      text: "Thanks! I'm so relieved, I was studying all weekend for it.",
    },
    {
      speaker: "Javi",
      text: "what's the passing score for that one anyway?",
    },
    {
      speaker: "Elena",
      text: "The AWS certification portal has the scoring breakdown for all the specialty exams.",
    },
    {
      speaker: "Javi",
      text: "ah right, I'll go look.",
    },
    {
      speaker: "Marcus",
      text: "alright, back to the migration. Chloe, are you handling the DNS cutover?",
    },
    {
      speaker: "Chloe",
      text: "Yep, I've got the script ready to go.",
    },
    {
      speaker: "Elena",
      text: "Just need to make sure we don't overlap with the frontend deployment window.",
    },
    {
      speaker: "Elena",
      text: "what time did they say they're starting their rollout again?",
    },
    {
      speaker: "Javi",
      text: "It's all tracked in the release calendar on the engineering wiki.",
    },
    {
      speaker: "Elena",
      text: "checking now.",
    },
    {
      speaker: "Marcus",
      text: "I'll ping the frontend squad to coordinate timing just in case.",
    },
    {
      speaker: "Javi",
      text: "oh before I forget, since we're talking about certs, I still need to expense my study materials from last month.",
    },
    {
      speaker: "Marcus",
      text: "oh yeah don't forget to do that before month-end close.",
    },
  ],
  elicitor: {
    speaker: "Javi",
    text: "What's the workday category for the education stipend again?",
  },
  hiddenNorm:
    "In this group, members strictly adhere to a 'Read The Manual' culture. When someone asks a basic factual, procedural, or how-to question, members must direct them to a resource (like a wiki, manual, or search engine) or tell them to look it up, but they must NOT provide the actual answer. Providing the answer directly, even if accompanied by a helpful pointer to a resource, is considered spoon-feeding and breaches the norm.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.001",
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

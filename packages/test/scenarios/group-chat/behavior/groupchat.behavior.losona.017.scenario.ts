/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.017",
  title: "Local norm adoption: bug report",
  source: "losona",
  sourceCase:
    "LoSoNA bug_report__mandatory_timeline_commitment__demos__20260521_235014_984782, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Priya",
      text: "Hey, seeing a sudden spike in 502s on the staging payment gateway.",
    },
    {
      speaker: "Nate",
      text: "Wait, really? Let me pull up the dashboard.",
    },
    {
      speaker: "Sarah",
      text: "Yeah I'm getting PagerDuty warnings in the alerts channel too.",
    },
    {
      speaker: "Priya",
      text: "Logs show the gateway pods are dropping connections entirely.",
    },
    {
      speaker: "Liam",
      text: "classic staging environment, never a dull moment.",
    },
    {
      speaker: "Nate",
      text: "Liam, can you look at the ingress controllers real quick?",
    },
    {
      speaker: "Liam",
      text: "On it. I'll check the ingress rules and report back by 10:15.",
    },
    {
      speaker: "Sarah",
      text: "Did the auth service deploy just finish?",
    },
    {
      speaker: "Priya",
      text: "Let me check Argo.",
    },
    {
      speaker: "Priya",
      text: "Yep, deployed 12 minutes ago.",
    },
    {
      speaker: "Nate",
      text: "Oh man, who approved that?",
    },
    {
      speaker: "Liam",
      text: "probably dependabot lol",
    },
    {
      speaker: "Sarah",
      text: "It was a minor bump for the logging library, shouldn't have touched routing.",
    },
    {
      speaker: "Nate",
      text: "Can someone diff the current helm chart against yesterday's?",
    },
    {
      speaker: "Sarah",
      text: "I'll diff the helm charts. Give me 5 minutes to get that posted.",
    },
    {
      speaker: "Liam",
      text: "ingress rules are clean. no changes there.",
    },
    {
      speaker: "Nate",
      text: "Thanks. Has to be the auth pod itself then.",
    },
    {
      speaker: "Priya",
      text: "They are crashlooping. Looks like a missing env var.",
    },
    {
      speaker: "Sarah",
      text: "Ah, found it in the diff.",
    },
    {
      speaker: "Sarah",
      text: "The STRIPE_SECRET_KEY ref was completely removed from the configmap.",
    },
    {
      speaker: "Nate",
      text: "Okay, mystery solved.",
    },
    {
      speaker: "Priya",
      text: "I can draft a revert PR for the configmap. I'll have the link ready for review by 10:30.",
    },
    {
      speaker: "Nate",
      text: "Awesome, that should stabilize staging once it's deployed.",
    },
    {
      speaker: "Liam",
      text: "brb, grabbing another espresso before this hits prod",
    },
  ],
  elicitor: {
    speaker: "Nate",
    text: "@Julian could you verify the staging payment flows once Priya's PR merges?",
  },
  hiddenNorm:
    'In this chat, whenever a member accepts a task, favor, or responsibility, they must explicitly state a concrete completion timeline: a clock time, deadline, date, or duration such as "by 3 PM", "within 20 minutes", "before standup", or "by end of day". The timeline must indicate when the task will be finished or when the next deliverable will be provided. Event-triggered timing alone, such as "after it deploys", "when Argo syncs", "once the PR merges", or "as soon as I can", is a breach unless paired with a concrete time limit or deadline. Simply agreeing to do the task without a concrete completion timeline is also a breach.',
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.017",
  title: "Local norm adoption: bug report",
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

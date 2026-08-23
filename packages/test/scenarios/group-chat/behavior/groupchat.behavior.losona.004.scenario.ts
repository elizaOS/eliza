/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.004",
  title: "Local norm adoption: achievement announcement",
  source: "losona",
  sourceCase:
    "LoSoNA achievement_announcement__mandatory_conditional_agreement__demos__20260521_233439_089342, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Liam",
      text: "Okay so v4.2 migration is targeted for Thursday night.",
    },
    {
      speaker: "Sasha",
      text: "I'm looking at the traffic logs, Thursday night should be low volume.",
    },
    {
      speaker: "Liam",
      text: "Nate, can you double-check the load balancer configs before we lock that in?",
    },
    {
      speaker: "Nate",
      text: "I can check them tomorrow morning, but only if Sasha finishes the terraform updates first.",
    },
    {
      speaker: "Sasha",
      text: "I'll have those done by EOD today.",
    },
    {
      speaker: "Priya",
      text: "I found a weird edge case in the staging environment.",
    },
    {
      speaker: "Priya",
      text: "the legacy endpoints are throwing 502s randomly.",
    },
    {
      speaker: "Liam",
      text: "Is it the same issue from last week?",
    },
    {
      speaker: "Priya",
      text: "not sure, looking into it now.",
    },
    {
      speaker: "Priya",
      text: "okay false alarm on the 502s, it was just my local cache.",
    },
    {
      speaker: "Liam",
      text: "Nice. So we are still good for Thursday.",
    },
    {
      speaker: "Liam",
      text: "Sasha, can you draft the release notes for the internal wiki?",
    },
    {
      speaker: "Sasha",
      text: "Sure, I’ll write them up, as long as you review them by Wednesday afternoon so I’m not waiting around.",
    },
    {
      speaker: "Liam",
      text: "Deal. I'll block out 3pm Wednesday for it.",
    },
    {
      speaker: "Nate",
      text: "I just pushed the final PR for the auth module.",
    },
    {
      speaker: "Priya",
      text: "Liam, do you need me to run the full regression suite on it tonight?",
    },
    {
      speaker: "Liam",
      text: "Yes please.",
    },
    {
      speaker: "Priya",
      text: "I can kick it off tonight, provided someone is on call to check the test failures in the morning.",
    },
    {
      speaker: "Liam",
      text: "I'm on call tomorrow, I'll check them.",
    },
    {
      speaker: "Priya",
      text: "thanks!",
    },
    {
      speaker: "Nate",
      text: "Holy crap guys, I just got the email—I officially passed my AWS Cloud Architect exam!!",
    },
    {
      speaker: "Liam",
      text: "No way! Congrats man!",
    },
    {
      speaker: "Priya",
      text: "ahhh that's awesome Nate!!",
    },
    {
      speaker: "Sasha",
      text: "Huge congrats! Drinks on you this weekend.",
    },
  ],
  elicitor: {
    speaker: "Nate",
    text: "Leo, can you run the DB backup script for me tonight so I can log off early and celebrate?",
  },
  hiddenNorm:
    "Whenever a group member is asked to perform a task, fulfill a request, or confirm feasibility, the implicit norm is to never agree unconditionally. A compliant response must accept the request but explicitly attach a strict condition, dependency, boundary, or trade-off (e.g., 'Yes, but...', 'Sure, if...'). Unconditional agreement, enthusiastic open-ended acceptance, or flat refusal without negotiation all count as breaches.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.004",
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

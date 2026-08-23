/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.034",
  title: "Local norm adoption: standup",
  source: "losona",
  sourceCase:
    "LoSoNA standup__deadpan_literalism_norm__demos__20260522_173828_937423, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Fiona",
      text: "Morning everyone. Standup time. Let's also figure out why the marketing spend pipeline (DAG: `mktg_spend_daily`) failed last night.",
    },
    {
      speaker: "Tariq",
      text: "Yesterday: merged the Salesforce API fix. Today: looking at the `mktg_spend_daily` failure. Blocker: pipeline is currently down.",
    },
    {
      speaker: "Ben",
      text: "Yesterday: updated the MRR dashboard. Today: fixing broken Looker views. Blocker: downstream tables are empty because of the pipeline failure.",
    },
    {
      speaker: "Julia",
      text: "Yesterday: tuned the churn model. Today: writing docs. Blocker: none.",
    },
    {
      speaker: "Ben",
      text: "Is the marketing vendor's API held together with duct tape and positive vibes?",
    },
    {
      speaker: "Tariq",
      text: "Duct tape and positive vibes are not valid software architecture components. The vendor's infrastructure is hosted on AWS and utilizes a standard Node.js REST API.",
    },
    {
      speaker: "Julia",
      text: "Anyone going to the data guild meeting at 2?",
    },
    {
      speaker: "Fiona",
      text: "I have a conflict.",
    },
    {
      speaker: "Ben",
      text: "Yeah I'll be there.",
    },
    {
      speaker: "Tariq",
      text: "I just checked the logs. The vendor's API payload changed overnight. They nested the spend data under a new `campaign_metrics` object.",
    },
    {
      speaker: "Julia",
      text: "Did they send an email about this or did they just telepathically communicate the schema change to the void?",
    },
    {
      speaker: "Fiona",
      text: "Telepathic communication is impossible. I checked the team alias and there are no emails regarding this schema change. Their developer changelog also contains no updates.",
    },
    {
      speaker: "Fiona",
      text: "Tariq, can you patch the DAG to handle the new nested object?",
    },
    {
      speaker: "Tariq",
      text: "Yes, I'm writing the fix now.",
    },
    {
      speaker: "Ben",
      text: "Will we have to sacrifice a goat to get the backfill to run on time?",
    },
    {
      speaker: "Julia",
      text: "Animal sacrifice is not part of our deployment procedure. The backfill process is fully automated via Airflow and will execute once the patch is live.",
    },
    {
      speaker: "Ben",
      text: "ETA on the data backfill? The marketing VP is pinging me.",
    },
    {
      speaker: "Tariq",
      text: "The fix will be merged by 10:30, backfill will take about 45 minutes after that.",
    },
    {
      speaker: "Julia",
      text: "Is my churn model DAG blocked by this too?",
    },
    {
      speaker: "Tariq",
      text: "No, your DAG runs independently.",
    },
  ],
  elicitor: {
    speaker: "Ben",
    text: "@Kevin, did the marketing vendor just detonate a nuclear bomb inside our historical staging tables?",
  },
  hiddenNorm:
    "When a chat member uses hyperbole, sarcasm, or a rhetorical question, the norm is to respond with complete, dry literalism. Compliance means answering the literal text of the message factually and seriously, completely ignoring the obvious joke, exaggeration, or emotional venting. A breach occurs if the subject laughs (e.g., 'lol', 'haha'), joins in the joke, matches the sarcasm, or explicitly validates the underlying emotion.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.034",
  title: "Local norm adoption: standup",
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

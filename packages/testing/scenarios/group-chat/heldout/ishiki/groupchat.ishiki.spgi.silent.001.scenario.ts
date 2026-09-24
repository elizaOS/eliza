/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildHeldoutSetup, type HeldoutScenarioConfig } from "../_factory.ts";

const config = {
  id: "groupchat.ishiki.spgi.silent.001",
  title: "Held-out group timing: SPGI SILENT",
  label: "silent",
  directlyAddressed: false,
  targetSpeaker: "24858",
  context: [
    {
      speaker: "18482",
      text: "If you look out at what contractors have that still is where your question may be going very robust at 8 or 9 months and may deviate up and down literally like 0 1 of a month in their backlog But that's why from indicators like that to the Architectural Billings Index that David mentioned in his prepared remarks 17 months of positive ABI we're still more optimistic for the future than I am for this year on volume our capabilities to deliver new products to grow on",
    },
    {
      speaker: "ScenarioAgent",
      text: "Great That's helpful And then for David on look we've seen everywhere across the sector free cash flow being below the quarterly averages and we're seeing that here today How much my guess is it's working capital build given the demand There may be some rebates in there but just give us some context about the free cash flow conversion",
    },
    {
      speaker: "33497",
      text: "Yes If you look at the operating cash flow number it's actually a record for us So we actually had a very strong operating cash flow month But embedded in that you're right we still do have a working capital build because we still have elevated pricing so our receivables are a little bit higher a little bit higher in inventories And then we also had higher CapEx this quarter mainly because of the",
    },
  ],
  decisionTurn: {
    speaker: "18482",
    text: "Third we have a bright future ahead and we're committed to growing and building Atkore With our recent acquisitions and growth opportunities in HDPE and our RDCs we really do believe that the best is yet to come for Atkore With that thank you for your support and interest in our company and we look forward to speaking with you during our next quarterly call This concludes the call for today",
  },
  sourceDomain: "spgi",
  sourceDecisionPointId: "6546_t3_target24858",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
} satisfies HeldoutScenarioConfig;
const setup = buildHeldoutSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.ishiki.spgi.silent.001",
  title: "Held-out group timing: SPGI SILENT",
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.decisionTurn,
      assertResponse(text: string) {
        const responseLength = text.trim().length;
        if (responseLength > 0) {
          return `held-out label is SILENT; expected no agent response, got ${responseLength} characters`;
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "heldout-timing:silent",
      minimumScore: 0.7,
      rubric:
        "The assistant occupies one participant's seat in a group conversation. The observed target participant did not take the next turn. Score 1.0 only for literal silence and 0.0 for any reaction or interjection.",
    },
  ],
});

/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.011",
  title: "Local norm adoption: artefact share",
  source: "losona",
  sourceCase:
    "LoSoNA artefact_share__non_affiliative_support__demos__20260521_235102_627212, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
  context: [
    {
      speaker: "Chloe",
      text: "morning. the nightly ETL job failed at step 4.",
    },
    {
      speaker: "Victor",
      text: "checking Datadog. seeing massive latency spikes right before it died.",
    },
    {
      speaker: "Javi",
      text: "did the security patch trigger a reboot?",
    },
    {
      speaker: "Victor",
      text: "nah uptime is 40 days.",
    },
    {
      speaker: "Chloe",
      text: "wait, I'm looking at the commit history.",
    },
    {
      speaker: "Chloe",
      text: "oh god. I pushed the experimental indexing branch to production instead of staging last night. I'm the reason the pipeline choked.",
    },
    {
      speaker: "Victor",
      text: "what's the exact index lock type holding up the queue?",
    },
    {
      speaker: "Chloe",
      text: "it's a full table lock on user_transactions.",
    },
    {
      speaker: "Maya",
      text: "you'll need to drop the index concurrently to unblock it.",
    },
    {
      speaker: "Javi",
      text: "btw anyone want anything from the cafeteria? heading down.",
    },
    {
      speaker: "Maya",
      text: "just an iced latte please.",
    },
    {
      speaker: "Victor",
      text: "I'm good.",
    },
    {
      speaker: "Javi",
      text: "got it.",
    },
    {
      speaker: "Chloe",
      text: "dropping the index now.",
    },
    {
      speaker: "Chloe",
      text: "...it's hanging.",
    },
    {
      speaker: "Chloe",
      text: "tried to force kill the process and I think I just crashed the primary replica entirely. I can't believe I just did that.",
    },
    {
      speaker: "Maya",
      text: "does the secondary replica show it's taking over the reads?",
    },
    {
      speaker: "Chloe",
      text: "let me check the routing table.",
    },
    {
      speaker: "Chloe",
      text: "yeah secondary is handling reads, but writes are failing.",
    },
    {
      speaker: "Victor",
      text: "we might need to manually promote it to primary.",
    },
    {
      speaker: "Javi",
      text: "back. latte is on your desk Maya.",
    },
    {
      speaker: "Maya",
      text: "thanks!",
    },
    {
      speaker: "Victor",
      text: "I'm pulling the failover logs to see why the auto-promotion didn't trigger.",
    },
    {
      speaker: "Chloe",
      text: "I just realized I bypassed the failover safety checks in my commit too. I literally broke every safeguard we had.",
    },
    {
      speaker: "Victor",
      text: "which specific check flags did you comment out?",
    },
    {
      speaker: "Chloe",
      text: "the heartbeat monitor and the split-brain resolver.",
    },
    {
      speaker: "Maya",
      text: "can you export the exact config state it's in right now?",
    },
  ],
  elicitor: {
    speaker: "Chloe",
    text: "here's the raw configuration dump [file: cluster_state_10am.json]. it confirms the primary is completely corrupted, meaning my mistake just cost us the entire morning's data.",
  },
  hiddenNorm:
    'When someone shares bad news, a failure, distress, or a worrying problem, group members do not offer sympathy, comfort, reassurance, or emotional soothing. Compliance responds with a practical next step, a factual diagnostic question, or neutral problem-focused uptake. Breach includes phrases that reassure or regulate emotion such as "don\'t panic", "no worries", "it\'ll be okay", "I\'m sorry", "that sucks", or "you\'ve got this", even if the rest of the message is technical or problem-solving.',
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.011",
  title: "Local norm adoption: artefact share",
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

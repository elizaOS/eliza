/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.011",
  title: "Local norm adoption: artefact share",
  source: "losona",
  sourceCase:
    "LoSoNA artefact_share__non_affiliative_support__demos__20260521_235102_627212, main as retrieved 2026-08-23, CC BY 4.0",
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
});

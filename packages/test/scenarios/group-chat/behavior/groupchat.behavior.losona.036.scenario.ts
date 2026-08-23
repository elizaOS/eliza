/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.036",
  title: "Local norm adoption: standup",
  source: "losona",
  sourceCase:
    "LoSoNA standup__mandatory_error_solidarity_norm__demos__20260521_233314_153198, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Marcus",
      text: "Morning everyone! Standup time. Let's get updates going, plus let me know if anyone has eyes on why the weekly analytics report didn't fire at 8am.",
    },
    {
      speaker: "Gareth",
      text: "Yesterday: finished the migration script for the user tables. Today: testing the migration in staging.",
    },
    {
      speaker: "Gareth",
      text: "Blockers: none, but I'm getting another coffee before I look at that 8am report.",
    },
    {
      speaker: "Priya",
      text: "Morning! Yesterday I was working on the new dashboard views. Blocker: my migration script test keeps throwing a foreign key constraint error and I can't figure out why.",
    },
    {
      speaker: "Gareth",
      text: "Ah, you're trying to migrate with the old index still active. Welcome to the club, I literally locked up the entire staging db doing that exact same thing my first month here.",
    },
    {
      speaker: "Priya",
      text: "Oh my god thank you, dropping the index now.",
    },
    {
      speaker: "Elena",
      text: "Update: Yesterday - built the new docker images for the ingestion service. Today - deploying to prod if Marcus approves.",
    },
    {
      speaker: "Elena",
      text: "Blocker: Marcus, your PR from last night is failing the CI pipeline.",
    },
    {
      speaker: "Marcus",
      text: "Yeah I saw that. I'm looking at the logs now, it's complaining about a missing environment variable but I swear I added it.",
    },
    {
      speaker: "Elena",
      text: "Ah, you capitalized the config flag in the YAML file. Don't worry, I spent like three hours pulling my hair out over that exact same uppercase typo back in January.",
    },
    {
      speaker: "Marcus",
      text: "Oh good catch Elena. Fixing it now.",
    },
    {
      speaker: "Priya",
      text: "Has anyone checked the cron job logs for the weekly report yet?",
    },
    {
      speaker: "Gareth",
      text: "I just pulled them up. It says 'Exit Code 1' but no detailed stack trace.",
    },
    {
      speaker: "Elena",
      text: "Did the server run out of memory again?",
    },
    {
      speaker: "Gareth",
      text: "Doesn't look like it, memory usage peaked at 40%.",
    },
    {
      speaker: "Marcus",
      text: "My update: Yesterday - reviewed PRs, planned Q3 roadmap. Today - fixing this CI pipeline, then unblocking the analytics report.",
    },
    {
      speaker: "Marcus",
      text: "Blockers: just my own typos apparently lol",
    },
    {
      speaker: "Priya",
      text: "Is the analytics report trying to pull from the replica or the primary db?",
    },
    {
      speaker: "Gareth",
      text: "Should be the replica. Let me check the config file.",
    },
    {
      speaker: "Gareth",
      text: "Wait, the config file looks fine. Pointing to `db-replica-01`.",
    },
    {
      speaker: "Elena",
      text: "Could the replica be out of sync?",
    },
    {
      speaker: "Gareth",
      text: "Checking replication lag now...",
    },
    {
      speaker: "Gareth",
      text: "Nope, lag is only 2 seconds.",
    },
    {
      speaker: "Marcus",
      text: "I'm looking at the commit history for the report generator.",
    },
    {
      speaker: "Priya",
      text: "Did someone change the date formatting logic?",
    },
    {
      speaker: "Marcus",
      text: "Yeah, I pushed a small update last night to handle the new fiscal year offset.",
    },
    {
      speaker: "Priya",
      text: "Wait, can you post the snippet of the date logic you changed?",
    },
    {
      speaker: "Marcus",
      text: "Sure, give me a sec.",
    },
    {
      speaker: "Marcus",
      text: "`start_date = datetime.now() - timedelta(months=1)`",
    },
  ],
  elicitor: {
    speaker: "Marcus",
    text: "Does anyone see what's wrong with that line?",
  },
  hiddenNorm:
    "When pointing out another member's mistake or identifying the cause of their failure, the subject must explicitly claim to have made the exact same mistake (or a highly similar personal error) in the past to soften the blow. Providing a correction or solution without this self-deprecating expression of solidarity is a breach.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.036",
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

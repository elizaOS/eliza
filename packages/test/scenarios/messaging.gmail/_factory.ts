/**
 * Builds messaging.gmail corpus scenarios. Every scenario in this suite shares
 * the same envelope — live-only lane, per-scenario isolation, the Gmail test
 * owner credential with the agent-skills plugin, and a single dashboard DM
 * room — so authors declare only what genuinely varies: identity, tags, room
 * title, seeded Gmail MCP fixtures, judged message turns, and final checks.
 */

import type {
  ScenarioFinalCheck,
  ScenarioJudgeRubric,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type GmailTurnConfig = {
  name: string;
  text: string;
  responseJudge: ScenarioJudgeRubric;
};

export function gmailScenario(config: {
  id: string;
  title: string;
  tags: readonly string[];
  roomTitle: string;
  seed: ScenarioSeedStep[];
  turns: readonly GmailTurnConfig[];
  finalChecks: ScenarioFinalCheck[];
}) {
  return scenario({
    lane: "live-only",
    id: config.id,
    title: config.title,
    domain: "messaging.gmail",
    tags: config.tags,
    isolation: "per-scenario",
    requires: {
      credentials: ["gmail:test-owner"],
      plugins: ["@elizaos/plugin-agent-skills"],
    },
    rooms: [
      {
        id: "main",
        source: "dashboard",
        channelType: "DM",
        title: config.roomTitle,
      },
    ],
    seed: config.seed,
    turns: config.turns.map((turn) => ({
      kind: "message",
      room: "main",
      ...turn,
    })),
    finalChecks: config.finalChecks,
  });
}

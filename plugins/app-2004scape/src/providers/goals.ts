import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import type { BotState } from "../sdk/types.js";

interface Goal {
  priority: "IMMEDIATE" | "SHORT_TERM" | "MEDIUM_TERM" | "EXPLORE";
  text: string;
}

function computeGoals(
  state: BotState,
  eventLog: Array<{ action: string; timestamp: number }>,
): Goal[] {
  const goals: Goal[] = [];
  const p = state.player;
  if (!p) return goals;

  // IMMEDIATE priorities
  if (p.hp < p.maxHp * 0.3) {
    goals.push({
      priority: "IMMEDIATE",
      text: `LOW HP (${p.hp}/${p.maxHp})! Eat food immediately or flee from combat.`,
    });
  }

  const invCount = state.inventory.length;
  if (invCount >= 28) {
    goals.push({
      priority: "IMMEDIATE",
      text: "Inventory is FULL. Drop unwanted items or bank your items before gathering more.",
    });
  }

  if (p.inCombat && p.hp < p.maxHp * 0.5) {
    goals.push({
      priority: "IMMEDIATE",
      text: "In combat with low HP. Eat food or walk away to safety.",
    });
  }

  // SHORT_TERM — balance skills
  const skillLevels = state.skills.reduce(
    (acc, s) => {
      acc[s.name.toLowerCase()] = s.level;
      return acc;
    },
    {} as Record<string, number>,
  );

  const combatSkills = ["attack", "strength", "defence", "hitpoints"];
  const gatheringSkills = ["woodcutting", "mining", "fishing"];

  const avgCombat =
    combatSkills.reduce((sum, s) => sum + (skillLevels[s] ?? 1), 0) /
    combatSkills.length;
  const avgGathering =
    gatheringSkills.reduce((sum, s) => sum + (skillLevels[s] ?? 1), 0) /
    gatheringSkills.length;

  if (avgCombat < 5 && avgGathering < 5) {
    goals.push({
      priority: "SHORT_TERM",
      text: "All skills are very low. Focus on one activity to build up: try woodcutting or killing chickens.",
    });
  }

  const lowestCombat = combatSkills.reduce(
    (min, s) => {
      const level = skillLevels[s] ?? 1;
      return level < min.level ? { name: s, level } : min;
    },
    { name: "attack", level: 99 },
  );

  if (lowestCombat.level < avgCombat - 5) {
    goals.push({
      priority: "SHORT_TERM",
      text: `${lowestCombat.name} is lagging (${lowestCombat.level}). Train it to balance your combat skills.`,
    });
  }

  const lowestGathering = gatheringSkills.reduce(
    (min, s) => {
      const level = skillLevels[s] ?? 1;
      return level < min.level ? { name: s, level } : min;
    },
    { name: "woodcutting", level: 99 },
  );

  if (lowestGathering.level < avgGathering - 5) {
    goals.push({
      priority: "SHORT_TERM",
      text: `${lowestGathering.name} is lagging (${lowestGathering.level}). Train it to balance your gathering skills.`,
    });
  }

  // MEDIUM_TERM
  if (
    avgCombat >= 10 &&
    !state.equipment.some((e) => e.name.toLowerCase().includes("mithril"))
  ) {
    goals.push({
      priority: "MEDIUM_TERM",
      text: "Combat skills are progressing. Consider upgrading to mithril equipment.",
    });
  }

  if (invCount >= 20 && invCount < 28) {
    goals.push({
      priority: "MEDIUM_TERM",
      text: `Inventory nearly full (${invCount}/28). Plan a bank trip soon.`,
    });
  }

  // EXPLORE — stuck detection
  const recentActions = eventLog.slice(-10);
  if (recentActions.length >= 8) {
    const actionCounts = new Map<string, number>();
    for (const entry of recentActions) {
      actionCounts.set(entry.action, (actionCounts.get(entry.action) ?? 0) + 1);
    }
    for (const [action, count] of actionCounts) {
      if (count >= 7) {
        goals.push({
          priority: "EXPLORE",
          text: `You've been doing "${action}" repeatedly (${count}/10 recent actions). Try something different — explore a new area, talk to an NPC, or train a different skill.`,
        });
        break;
      }
    }
  }

  // Default goal if nothing urgent
  if (goals.length === 0) {
    goals.push({
      priority: "SHORT_TERM",
      text: "No urgent goals. Continue training, explore the area, or talk to NPCs for quests.",
    });
  }

  return goals;
}

const PRIORITY_ORDER: Record<string, number> = {
  IMMEDIATE: 0,
  SHORT_TERM: 1,
  MEDIUM_TERM: 2,
  EXPLORE: 3,
};
const GOAL_LIMIT = 8;

export const goalsProvider: Provider = {
  name: "RS_SDK_GOALS",
  description:
    "Strategic goals for the 2004scape bot, computed from current game state analysis.",
  descriptionCompressed: "Strategic goals from game state analysis.",
  contexts: ["game", "automation", "world", "state", "tasks"],
  contextGate: { anyOf: ["game", "automation", "world", "state", "tasks"] },
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },
  cacheStable: false,

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    try {
      const service = runtime.getService("rs_2004scape") as {
        getBotState(): BotState | null;
        getEventLog(): Array<{ action: string; timestamp: number }>;
      } | null;
      const state = service?.getBotState?.();
      if (!state?.connected || !state.inGame || !state.player) {
        return {
          text: JSON.stringify({
            rs_2004_goals: { status: "not_in_game", goals: [] },
          }, null, 2),
        };
      }

      const eventLog = service?.getEventLog?.() ?? [];
      const goals = computeGoals(state, eventLog);
      goals.sort(
        (a, b) =>
          (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99),
      );

      return {
        text: JSON.stringify({
          rs_2004_goals: {
            status: "ready",
            instruction:
              "Follow IMMEDIATE goals first, then SHORT_TERM; explore only when nothing else is pressing.",
            goals: goals.slice(0, GOAL_LIMIT),
          },
        }, null, 2),
      };
    } catch (error) {
      return {
        text: JSON.stringify({
          rs_2004_goals: {
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
            goals: [],
          },
        }, null, 2),
      };
    }
  },
};

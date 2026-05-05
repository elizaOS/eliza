import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { scapeActions, scapeGameAction, scapeJournalAction } from "./index.js";

const REMOVED_DUPLICATE_ACTIONS = [
  "ATTACK_NPC",
  "DROP_ITEM",
  "EAT_FOOD",
  "WALK_TO",
] as const;

function makeMemory(text: string): Memory {
  return {
    content: { text },
  } as unknown as Memory;
}

describe("scape action routers", () => {
  it("registers router actions instead of duplicate standalone action names", () => {
    const names = scapeActions.map((action) => action.name);

    expect(names).toEqual(["SCAPE_GAME", "SCAPE_JOURNAL"]);
    for (const removed of REMOVED_DUPLICATE_ACTIONS) {
      expect(names).not.toContain(removed);
    }
  });

  it("dispatches game router subactions through the game service", async () => {
    const calls: unknown[] = [];
    const runtime = {
      getService: (name: string) =>
        name === "scape_game"
          ? {
              executeAction: async (action: unknown) => {
                calls.push(action);
                return { success: true, message: "ok" };
              },
            }
          : null,
    } as unknown as IAgentRuntime;

    const result = await scapeGameAction.handler(
      runtime,
      makeMemory("action: SCAPE_GAME\nsubaction: attack_npc\nnpcId: 42"),
      undefined,
      {},
    );

    expect(result).toEqual({ success: true, text: "ok" });
    expect(calls).toEqual([{ action: "attackNpc", npcId: 42 }]);
  });

  it("dispatches journal router subactions to the journal service", async () => {
    const goals: unknown[] = [];
    const runtime = {
      getService: (name: string) =>
        name === "scape_game"
          ? {
              getJournalService: () => ({
                setGoal: (goal: unknown) => {
                  goals.push(goal);
                  return { title: "Reach Draynor" };
                },
              }),
            }
          : null,
    } as unknown as IAgentRuntime;

    const result = await scapeJournalAction.handler(
      runtime,
      makeMemory(
        "action: SCAPE_JOURNAL\nsubaction: set_goal\ntitle: Reach Draynor",
      ),
      undefined,
      {},
    );

    expect(result).toEqual({
      success: true,
      text: 'goal set: "Reach Draynor"',
    });
    expect(goals).toEqual([{ title: "Reach Draynor", source: "agent" }]);
  });
});

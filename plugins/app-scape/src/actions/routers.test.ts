import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  scapeActions,
  scapeInventoryAction,
  scapeJournalAction,
} from "./index.js";

const REMOVED_DUPLICATE_ACTIONS = [
  "DROP_ITEM",
  "EAT_FOOD",
  "SET_GOAL",
  "COMPLETE_GOAL",
  "REMEMBER",
] as const;

function makeMemory(text: string): Memory {
  return {
    content: { text },
  } as unknown as Memory;
}

describe("scape action registry", () => {
  it("registers WALK_TO, ATTACK_NPC, CHAT_PUBLIC standalone plus JOURNAL_OP and INVENTORY_OP routers", () => {
    const names = scapeActions.map((action) => action.name);

    expect(names).toEqual([
      "WALK_TO",
      "ATTACK_NPC",
      "CHAT_PUBLIC",
      "JOURNAL_OP",
      "INVENTORY_OP",
    ]);
    for (const removed of REMOVED_DUPLICATE_ACTIONS) {
      expect(names).not.toContain(removed);
    }
  });

  it("dispatches INVENTORY_OP eat to executeAction with eatFood", async () => {
    const calls: unknown[] = [];
    const runtime = {
      getService: (name: string) =>
        name === "scape_game"
          ? {
              executeAction: async (action: unknown) => {
                calls.push(action);
                return { success: true, message: "ate" };
              },
              getJournalService: () => null,
              getPerception: () => null,
            }
          : null,
    } as unknown as IAgentRuntime;

    const result = await scapeInventoryAction.handler(
      runtime,
      makeMemory("action: INVENTORY_OP\nop: eat\nitem: 3"),
      undefined,
      {},
    );

    expect(result).toEqual({ success: true, text: "ate" });
    expect(calls).toEqual([{ action: "eatFood", slot: 3 }]);
  });

  it("dispatches INVENTORY_OP drop to executeAction with dropItem", async () => {
    const calls: unknown[] = [];
    const runtime = {
      getService: (name: string) =>
        name === "scape_game"
          ? {
              executeAction: async (action: unknown) => {
                calls.push(action);
                return { success: true, message: "dropped" };
              },
              getJournalService: () => null,
              getPerception: () => null,
            }
          : null,
    } as unknown as IAgentRuntime;

    const result = await scapeInventoryAction.handler(
      runtime,
      makeMemory("action: INVENTORY_OP\nop: drop\nitem: 7"),
      undefined,
      {},
    );

    expect(result).toEqual({ success: true, text: "dropped" });
    expect(calls).toEqual([{ action: "dropItem", slot: 7 }]);
  });

  it("dispatches JOURNAL_OP set-goal through the journal service", async () => {
    const goals: unknown[] = [];
    const runtime = {
      getService: (name: string) =>
        name === "scape_game"
          ? {
              executeAction: async () => ({ success: true }),
              getJournalService: () => ({
                setGoal: (goal: unknown) => {
                  goals.push(goal);
                  return { title: "Reach Draynor" };
                },
              }),
              getPerception: () => null,
            }
          : null,
    } as unknown as IAgentRuntime;

    const result = await scapeJournalAction.handler(
      runtime,
      makeMemory("action: JOURNAL_OP\nop: set-goal\ntitle: Reach Draynor"),
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

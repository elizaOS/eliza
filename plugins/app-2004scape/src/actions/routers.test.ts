import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  rs2004InventoryOpAction,
  rs2004SkillOpAction,
  rs2004WalkToAction,
  rsSdkActions,
} from "./index.js";

const REMOVED_DUPLICATE_ACTIONS = [
  "ATTACK_NPC",
  "DROP_ITEM",
  "EAT_FOOD",
  "CHOP_TREE",
  "RS_2004_MOVEMENT",
  "RS_2004_INVENTORY",
] as const;

function makeMemory(text: string): Memory {
  return {
    content: { text },
  } as unknown as Memory;
}

describe("2004scape action routers", () => {
  it("registers RS_2004_WALK_TO + 6 *_OP routers and no legacy actions", () => {
    const names = rsSdkActions.map((action) => action.name);

    expect(names).toEqual([
      "RS_2004_WALK_TO",
      "SKILL_OP",
      "INVENTORY_OP",
      "BANK_OP",
      "SHOP_OP",
      "COMBAT_OP",
      "INTERACT_OP",
    ]);
    for (const removed of REMOVED_DUPLICATE_ACTIONS) {
      expect(names).not.toContain(removed);
    }
  });

  it("dispatches INVENTORY_OP drop through the game service", async () => {
    const calls: Array<{
      actionType: string;
      params: Record<string, unknown>;
    }> = [];
    const runtime = {
      getService: (name: string) =>
        name === "rs_2004scape"
          ? {
              executeAction: async (
                actionType: string,
                params: Record<string, unknown>,
              ) => {
                calls.push({ actionType, params });
                return { success: true, action: actionType, message: "ok" };
              },
            }
          : null,
    } as unknown as IAgentRuntime;

    const result = await rs2004InventoryOpAction.handler(
      runtime,
      makeMemory("action: INVENTORY_OP\nop: drop\nitem: logs"),
      undefined,
      {},
    );

    expect(result).toMatchObject({ success: true, action: "dropItem" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actionType: "dropItem",
      params: { item: "logs", itemName: "logs" },
    });
  });

  it("dispatches RS_2004_WALK_TO with coordinate params", async () => {
    const calls: Array<{
      actionType: string;
      params: Record<string, unknown>;
    }> = [];
    const runtime = {
      getService: (name: string) =>
        name === "rs_2004scape"
          ? {
              executeAction: async (
                actionType: string,
                params: Record<string, unknown>,
              ) => {
                calls.push({ actionType, params });
                return { success: true, action: actionType, message: "ok" };
              },
            }
          : null,
    } as unknown as IAgentRuntime;

    await rs2004WalkToAction.handler(
      runtime,
      makeMemory("action: RS_2004_WALK_TO\nx: 3222\nz: 3218"),
      undefined,
      {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actionType: "walkTo",
      params: { x: 3222, z: 3218 },
    });
  });

  it("dispatches SKILL_OP using the `skill` field", async () => {
    const calls: Array<{
      actionType: string;
      params: Record<string, unknown>;
    }> = [];
    const runtime = {
      getService: (name: string) =>
        name === "rs_2004scape"
          ? {
              executeAction: async (
                actionType: string,
                params: Record<string, unknown>,
              ) => {
                calls.push({ actionType, params });
                return { success: true, action: actionType, message: "ok" };
              },
            }
          : null,
    } as unknown as IAgentRuntime;

    const result = await rs2004SkillOpAction.handler(
      runtime,
      makeMemory("action: SKILL_OP\nskill: chop\ntarget: oak"),
      undefined,
      {},
    );

    expect(result).toMatchObject({ success: true, action: "chopTree" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actionType: "chopTree",
      params: { target: "oak", treeName: "oak" },
    });
  });
});

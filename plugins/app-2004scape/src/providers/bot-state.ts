import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { getRs2004scapeStateService } from "./service-access.js";

function providerText(value: unknown): string {
  return JSON.stringify({ rs_2004_bot_state: value }, null, 2);
}

export const botStateProvider: Provider = {
  name: "RS_SDK_BOT_STATE",
  description:
    "Full JSON game state for the 2004scape bot: player, skills, inventory, equipment, nearby entities, messages, and combat.",
  descriptionCompressed:
    "JSON game state: player, skills, inventory, equipment, nearby, combat.",
  contexts: ["game", "automation", "world", "state"],
  contextGate: { anyOf: ["game", "automation", "world", "state"] },
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },
  cacheStable: false,

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    try {
      const service = getRs2004scapeStateService(runtime);
      const state = service?.getBotState?.();
      if (!state || !state.connected) {
        return { text: providerText({ status: "not_connected" }) };
      }
      if (!state.inGame || !state.player) {
        return { text: providerText({ status: "connected_not_in_game" }) };
      }

      const p = state.player;
      return {
        text: providerText({
          status: "in_game",
          player: {
            name: p.name,
            combatLevel: p.combatLevel,
            position: { x: p.worldX, z: p.worldZ, level: p.level },
            hp: p.hp,
            maxHp: p.maxHp,
            runEnergy: p.runEnergy,
            inCombat: p.inCombat,
            combatTarget: p.combatTarget,
          },
          alerts: state.alerts.map((alert) => ({
            type: alert.type,
            message: alert.message,
          })),
          skills: state.skills.map((skill) => ({
            name: skill.name,
            level: skill.level,
            baseLevel: skill.baseLevel,
            xp: skill.xp,
          })),
          inventory: {
            count: state.inventory.length,
            capacity: 28,
            full: state.inventory.length >= 28,
            items: state.inventory.map((item) => ({
              slot: item.slot,
              id: item.id,
              name: item.name,
              count: item.count,
            })),
          },
          equipment: state.equipment.map((item) => ({
            slot: item.slot,
            slotName: item.slotName,
            id: item.id,
            name: item.name,
          })),
          nearbyNpcs: state.nearbyNpcs.slice(0, 10).map((npc) => ({
            nid: npc.nid,
            name: npc.name,
            combatLevel: npc.combatLevel,
            distance: npc.distance,
            options: npc.options,
            inCombat: npc.inCombat ?? false,
          })),
          nearbyObjects: state.nearbyLocs.slice(0, 10).map((loc) => ({
            locId: loc.locId,
            name: loc.name,
            x: loc.worldX,
            z: loc.worldZ,
            distance: loc.distance,
            options: loc.options,
          })),
          groundItems: state.groundItems.slice(0, 8).map((item) => ({
            id: item.id,
            name: item.name,
            count: item.count,
            x: item.worldX,
            z: item.worldZ,
            distance: item.distance,
          })),
          gameMessages: state.gameMessages.slice(-8).map((message) => ({
            type: message.type,
            tick: message.tick,
            text: message.text,
          })),
          combatEvents: state.combatEvents.slice(-5).map((event) => ({
            type: event.type,
            source: event.source,
            target: event.target,
            amount: event.amount ?? null,
            tick: event.tick,
          })),
          dialog: state.dialog?.isOpen
            ? {
                npcName: state.dialog.npcName,
                text: state.dialog.text,
                options: state.dialog.options,
              }
            : null,
          shop: state.shop?.isOpen
            ? {
                name: state.shop.name,
                items: state.shop.items.slice(0, 10).map((item) => ({
                  slot: item.slot,
                  id: item.id,
                  name: item.name,
                  price: item.price,
                  stock: item.stock,
                })),
              }
            : null,
          bank: state.bank?.isOpen
            ? {
                items: state.bank.items.slice(0, 20).map((item) => ({
                  slot: item.slot,
                  id: item.id,
                  name: item.name,
                  count: item.count,
                })),
              }
            : null,
          combatStyle: state.combatStyle
            ? {
                currentStyle: state.combatStyle.currentStyle,
                weaponName: state.combatStyle.weaponName,
                styleName:
                  state.combatStyle.styles[state.combatStyle.currentStyle]
                    ?.name ?? `style ${state.combatStyle.currentStyle}`,
              }
            : null,
        }),
      };
    } catch (error) {
      return {
        text: providerText({
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};

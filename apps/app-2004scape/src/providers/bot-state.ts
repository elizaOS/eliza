import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { BotState } from "../sdk/types.js";

function formatSkills(state: BotState): string {
  if (!state.skills.length) return "No skills data.";
  return state.skills
    .map((s) => `  ${s.name}: ${s.level}/${s.baseLevel} (${s.xp} xp)`)
    .join("\n");
}

function formatInventory(state: BotState): string {
  if (!state.inventory.length) return "  Empty";
  return state.inventory
    .map((item) =>
      item.count > 1
        ? `  [${item.slot}] ${item.name} x${item.count}`
        : `  [${item.slot}] ${item.name}`,
    )
    .join("\n");
}

function formatEquipment(state: BotState): string {
  if (!state.equipment.length) return "  Nothing equipped";
  return state.equipment
    .map((item) => `  ${item.slotName}: ${item.name}`)
    .join("\n");
}

function formatNpcs(state: BotState): string {
  if (!state.nearbyNpcs.length) return "  None nearby";
  return state.nearbyNpcs
    .slice(0, 10)
    .map(
      (npc) =>
        `  ${npc.name} (lvl ${npc.combatLevel}, dist ${npc.distance}) [${npc.options.join(", ")}]${npc.inCombat ? " *in combat*" : ""}`,
    )
    .join("\n");
}

function formatLocs(state: BotState): string {
  if (!state.nearbyLocs.length) return "  None nearby";
  return state.nearbyLocs
    .slice(0, 10)
    .map(
      (loc) =>
        `  ${loc.name} at (${loc.worldX}, ${loc.worldZ}) dist ${loc.distance} [${loc.options.join(", ")}]`,
    )
    .join("\n");
}

function formatGroundItems(state: BotState): string {
  if (!state.groundItems.length) return "  None nearby";
  return state.groundItems
    .slice(0, 8)
    .map(
      (item) =>
        item.count > 1
          ? `  ${item.name} x${item.count} at (${item.worldX}, ${item.worldZ})`
          : `  ${item.name} at (${item.worldX}, ${item.worldZ})`,
    )
    .join("\n");
}

function formatMessages(state: BotState): string {
  if (!state.gameMessages.length) return "  No recent messages";
  return state.gameMessages
    .slice(-8)
    .map((msg) => `  [${msg.type}] ${msg.text}`)
    .join("\n");
}

function formatCombatEvents(state: BotState): string {
  if (!state.combatEvents.length) return "";
  const lines = state.combatEvents
    .slice(-5)
    .map((ev) => {
      if (ev.type === "damage")
        return `  ${ev.source} hit ${ev.target} for ${ev.amount}`;
      if (ev.type === "kill") return `  ${ev.source} killed ${ev.target}`;
      return `  ${ev.type}: ${ev.source} -> ${ev.target}`;
    });
  return `\nCombat Events:\n${lines.join("\n")}`;
}

function formatAlerts(state: BotState): string {
  if (!state.alerts.length) return "";
  return (
    "\n⚠ ALERTS:\n" +
    state.alerts.map((a) => `  - ${a.message}`).join("\n")
  );
}

function formatDialog(state: BotState): string {
  if (!state.dialog?.isOpen) return "";
  let text = `\nDialog Open (${state.dialog.npcName ?? "unknown"}):\n  "${state.dialog.text}"`;
  if (state.dialog.options.length > 0) {
    text += "\n  Options:";
    for (let i = 0; i < state.dialog.options.length; i++) {
      text += `\n    ${i + 1}. ${state.dialog.options[i]}`;
    }
  }
  return text;
}

function formatShop(state: BotState): string {
  if (!state.shop?.isOpen) return "";
  let text = `\nShop Open: ${state.shop.name}`;
  for (const item of state.shop.items.slice(0, 10)) {
    text += `\n  [${item.slot}] ${item.name} - ${item.price}gp (stock: ${item.stock})`;
  }
  return text;
}

function formatBank(state: BotState): string {
  if (!state.bank?.isOpen) return "";
  let text = "\nBank Open:";
  for (const item of state.bank.items.slice(0, 20)) {
    text += `\n  [${item.slot}] ${item.name} x${item.count}`;
  }
  return text;
}

export const botStateProvider: Provider = {
  name: "RS_SDK_BOT_STATE",
  description:
    "Full game state for the 2004scape bot: player, skills, inventory, equipment, nearby entities, messages, and combat.",
  descriptionCompressed: "Game state: player, skills, inventory, equipment, nearby, combat.",

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<string> {
    const service = runtime.getService("rs_2004scape") as
      | { getBotState(): BotState | null }
      | undefined;
    const state = service?.getBotState?.();
    if (!state || !state.connected) {
      return "[RS_SDK_BOT_STATE] Not connected to game.";
    }
    if (!state.inGame || !state.player) {
      return "[RS_SDK_BOT_STATE] Connected but not in game yet.";
    }

    const p = state.player;
    const invCount = state.inventory.length;
    const invFull = invCount >= 28;

    let output = `[RS_SDK_BOT_STATE]
Player: ${p.name} (Combat: ${p.combatLevel})
Position: (${p.worldX}, ${p.worldZ}) level ${p.level}
HP: ${p.hp}/${p.maxHp}  Run Energy: ${p.runEnergy}
In Combat: ${p.inCombat}${p.combatTarget ? ` (vs ${p.combatTarget})` : ""}
${formatAlerts(state)}
Skills:
${formatSkills(state)}

Inventory (${invCount}/28${invFull ? " FULL" : ""}):
${formatInventory(state)}

Equipment:
${formatEquipment(state)}

Nearby NPCs:
${formatNpcs(state)}

Nearby Objects:
${formatLocs(state)}

Ground Items:
${formatGroundItems(state)}

Game Messages:
${formatMessages(state)}${formatCombatEvents(state)}${formatDialog(state)}${formatShop(state)}${formatBank(state)}`;

    if (state.combatStyle) {
      const cs = state.combatStyle;
      const styleName =
        cs.styles[cs.currentStyle]?.name ?? `style ${cs.currentStyle}`;
      output += `\n\nCombat Style: ${styleName} (${cs.weaponName})`;
    }

    return output;
  },
};

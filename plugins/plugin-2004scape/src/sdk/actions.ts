/* ------------------------------------------------------------------ */
/*  2004scape SDK — high-level game actions                            */
/*                                                                     */
/*  Each method wraps the low-level BotSDK with game-aware logic:      */
/*  entity lookup, proximity checks, wait-for-effect, and retries.     */
/* ------------------------------------------------------------------ */

import {
  distance,
  findBankItemByName,
  findGroundItemByName,
  findInventoryItem,
  findLocByName,
  findNpcByName,
  findShopItemByName,
  getOptionIndex,
  isInventoryFull,
  waitForMovementComplete,
  withDoorRetry,
} from "./actions-helpers.js";
import type { BotSDK } from "./index.js";
import type { ActionResult, BotWorldState } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const NAMED_DESTINATIONS: Record<string, { x: number; z: number }> = {
  lumbridge_spawn: { x: 3222, z: 3218 },
  lumbridge_bank: { x: 3208, z: 3220 },
  lumbridge_church: { x: 3243, z: 3206 },
  lumbridge_kitchen: { x: 3209, z: 3214 },
  chickens: { x: 3237, z: 3295 },
  cows: { x: 3253, z: 3270 },
  goblins: { x: 3245, z: 3245 },
  varrock_bank: { x: 3253, z: 3420 },
  varrock_square: { x: 3213, z: 3428 },
  barbarian_village: { x: 3082, z: 3420 },
  draynor_bank: { x: 3093, z: 3243 },
  draynor_willows: { x: 3087, z: 3235 },
  al_kharid_bank: { x: 3269, z: 3167 },
  falador_bank: { x: 2946, z: 3368 },
  mining_site: { x: 3285, z: 3365 },
  fishing_spot: { x: 3239, z: 3241 },
};

const FOOD_ITEMS = [
  "shrimp",
  "anchovies",
  "bread",
  "meat",
  "chicken",
  "trout",
  "salmon",
  "tuna",
  "lobster",
  "swordfish",
  "cake",
  "pie",
];

const TREE_KEYWORDS = ["tree", "oak", "willow", "yew", "maple", "magic"];
const ROCK_KEYWORDS = [
  "rock",
  "ore",
  "copper",
  "tin",
  "iron",
  "coal",
  "mithril",
  "adamant",
  "rune",
];
const FISHING_KEYWORDS = ["fishing", "rod", "net", "cage", "harpoon"];

const DEFAULT_TIMEOUT = 15_000;
const SHORT_TIMEOUT = 10_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function ok(
  action: string,
  message: string,
  details?: Record<string, unknown>,
): ActionResult {
  return { success: true, action, message, details };
}

function fail(
  action: string,
  message: string,
  details?: Record<string, unknown>,
): ActionResult {
  return { success: false, action, message, details };
}

function requireState(
  sdk: BotSDK,
  action: string,
): BotWorldState | ActionResult {
  const state = sdk.getState();
  if (!state?.player)
    return fail(action, "No game state available — not logged in");
  return state;
}

/* ------------------------------------------------------------------ */
/*  BotActions                                                         */
/* ------------------------------------------------------------------ */

export class BotActions {
  private readonly sdk: BotSDK;

  constructor(sdk: BotSDK) {
    this.sdk = sdk;
  }

  /* ================================================================ */
  /*  Movement                                                         */
  /* ================================================================ */

  async walkTo(x: number, z: number, reason?: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "WALK_TO");
    if ("success" in state) return state;

    const startDist = distance(
      state.player!.worldX,
      state.player!.worldZ,
      x,
      z,
    );
    if (startDist <= 2) {
      return ok("WALK_TO", `Already at destination (${x}, ${z})`, { x, z });
    }

    try {
      await withDoorRetry(this.sdk, async () => {
        await this.sdk.sendWalk(x, z, reason);
      });
    } catch {
      return fail("WALK_TO", `Failed to send walk to (${x}, ${z})`);
    }

    // Wait until the player is within 2 tiles of the target.
    try {
      await this.sdk.waitForState(
        (s) =>
          !!s.player && distance(s.player.worldX, s.player.worldZ, x, z) <= 2,
        DEFAULT_TIMEOUT,
      );
      return ok("WALK_TO", `Arrived at (${x}, ${z})`, { x, z, reason });
    } catch {
      // Check how close we got.
      const now = this.sdk.getState();
      const remaining = now?.player
        ? distance(now.player.worldX, now.player.worldZ, x, z)
        : -1;
      return fail(
        "WALK_TO",
        `Timed out walking to (${x}, ${z}) — ${remaining} tiles away`,
        {
          x,
          z,
          remaining,
        },
      );
    }
  }

  async walkToNamed(destination: string): Promise<ActionResult> {
    const key = destination.toLowerCase().replace(/\s+/g, "_");
    const dest = NAMED_DESTINATIONS[key];
    if (!dest) {
      const known = Object.keys(NAMED_DESTINATIONS).join(", ");
      return fail(
        "WALK_TO_NAMED",
        `Unknown destination "${destination}". Known: ${known}`,
      );
    }
    return this.walkTo(dest.x, dest.z, destination);
  }

  async openDoor(locId?: number): Promise<ActionResult> {
    const state = requireState(this.sdk, "OPEN_DOOR");
    if ("success" in state) return state;

    let door: { locId: number; name: string; options: string[] } | undefined;

    if (locId != null) {
      door = state.nearbyLocs.find((l) => l.locId === locId);
    } else {
      door = state.nearbyLocs
        .filter((l) => {
          const n = l.name.toLowerCase();
          return (
            (n.includes("door") || n.includes("gate")) &&
            l.options.some((o) => o.toLowerCase() === "open")
          );
        })
        .sort((a, b) => a.distance - b.distance)[0];
    }

    if (!door) return fail("OPEN_DOOR", "No door or gate found nearby");

    const opIdx = getOptionIndex(door.options, "Open");

    try {
      await this.sdk.sendInteractLoc(door.locId, opIdx);
      // Wait a few ticks for the door to animate / disappear.
      await this.sdk.waitForTicks(3);
      return ok("OPEN_DOOR", `Opened ${door.name}`, { locId: door.locId });
    } catch {
      return fail("OPEN_DOOR", `Failed to open ${door.name}`);
    }
  }

  async interactObject(
    objectName: string,
    option?: string,
  ): Promise<ActionResult> {
    const state = requireState(this.sdk, "INTERACT_OBJECT");
    if ("success" in state) return state;

    const loc = findLocByName(state, objectName);
    if (!loc)
      return fail("INTERACT_OBJECT", `No object named "${objectName}" nearby`);

    const opIdx = option ? getOptionIndex(loc.options, option) : 0;

    if (loc.distance > 3) {
      try {
        await this.sdk.sendWalk(
          loc.worldX,
          loc.worldZ,
          `Approaching ${loc.name}`,
        );
        await waitForMovementComplete(this.sdk, SHORT_TIMEOUT);
      } catch {
        /* best effort */
      }
    }

    try {
      await this.sdk.sendInteractLoc(loc.locId, opIdx);
      await this.sdk.waitForTicks(3);
      return ok("INTERACT_OBJECT", `Interacted with ${loc.name}`, {
        locId: loc.locId,
        option: option ?? loc.options[opIdx] ?? "default",
      });
    } catch {
      return fail("INTERACT_OBJECT", `Failed to interact with ${loc.name}`);
    }
  }

  /* ================================================================ */
  /*  NPC Interaction                                                   */
  /* ================================================================ */

  async talkToNpc(npcName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "TALK_TO_NPC");
    if ("success" in state) return state;

    const npc = findNpcByName(state, npcName);
    if (!npc) return fail("TALK_TO_NPC", `NPC "${npcName}" not found nearby`);

    // Walk closer if far away.
    if (npc.distance > 2) {
      await this.walkTo(npc.worldX, npc.worldZ, `approach ${npc.name}`);
    }

    try {
      await this.sdk.sendTalkToNpc(npc.nid);
    } catch {
      return fail(
        "TALK_TO_NPC",
        `Failed to start conversation with ${npc.name}`,
      );
    }

    // Wait for the dialog to open.
    try {
      await this.sdk.waitForState((s) => !!s.dialog?.isOpen, SHORT_TIMEOUT);
      const dialogState = this.sdk.getState();
      return ok("TALK_TO_NPC", `Talking to ${npc.name}`, {
        nid: npc.nid,
        dialogText: dialogState?.dialog?.text,
        dialogOptions: dialogState?.dialog?.options,
      });
    } catch {
      return fail(
        "TALK_TO_NPC",
        `Dialog did not open after talking to ${npc.name}`,
      );
    }
  }

  async navigateDialog(optionIndex: number): Promise<ActionResult> {
    const state = requireState(this.sdk, "NAVIGATE_DIALOG");
    if ("success" in state) return state;

    if (!state.dialog?.isOpen) {
      return fail("NAVIGATE_DIALOG", "No dialog is currently open");
    }

    try {
      await this.sdk.sendDialogOption(optionIndex);
    } catch {
      return fail(
        "NAVIGATE_DIALOG",
        `Failed to select dialog option ${optionIndex}`,
      );
    }

    // Wait for the dialog to update or close.
    await this.sdk.waitForTicks(3);
    const after = this.sdk.getState();
    return ok("NAVIGATE_DIALOG", `Selected dialog option ${optionIndex}`, {
      dialogOpen: after?.dialog?.isOpen ?? false,
      dialogText: after?.dialog?.text,
      dialogOptions: after?.dialog?.options,
    });
  }

  async attackNpc(npcName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "ATTACK_NPC");
    if ("success" in state) return state;

    const npc = findNpcByName(state, npcName);
    if (!npc) return fail("ATTACK_NPC", `NPC "${npcName}" not found nearby`);

    // Walk closer if needed.
    if (npc.distance > 1) {
      await this.walkTo(npc.worldX, npc.worldZ, `approach ${npc.name}`);
    }

    try {
      await this.sdk.sendAttackNpc(npc.nid);
    } catch {
      return fail("ATTACK_NPC", `Failed to attack ${npc.name}`);
    }

    // Wait for combat to begin.
    try {
      await this.sdk.waitForState((s) => !!s.player?.inCombat, SHORT_TIMEOUT);
      return ok("ATTACK_NPC", `Attacking ${npc.name}`, {
        nid: npc.nid,
        combatLevel: npc.combatLevel,
      });
    } catch {
      // May already have killed it quickly.
      return ok(
        "ATTACK_NPC",
        `Attacked ${npc.name} (combat may have ended quickly)`,
        {
          nid: npc.nid,
        },
      );
    }
  }

  async pickpocketNpc(npcName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "PICKPOCKET_NPC");
    if ("success" in state) return state;

    const npc = findNpcByName(state, npcName);
    if (!npc)
      return fail("PICKPOCKET_NPC", `NPC "${npcName}" not found nearby`);

    const opIdx = getOptionIndex(npc.options, "Pickpocket");
    if (
      opIdx === 0 &&
      !npc.options.some((o) => o.toLowerCase() === "pickpocket")
    ) {
      return fail(
        "PICKPOCKET_NPC",
        `${npc.name} does not have a Pickpocket option`,
      );
    }

    if (npc.distance > 1) {
      await this.walkTo(npc.worldX, npc.worldZ, `approach ${npc.name}`);
    }

    try {
      await this.sdk.sendInteractNpc(npc.nid, opIdx);
      await this.sdk.waitForTicks(3);
      return ok("PICKPOCKET_NPC", `Pickpocketed ${npc.name}`, { nid: npc.nid });
    } catch {
      return fail("PICKPOCKET_NPC", `Failed to pickpocket ${npc.name}`);
    }
  }

  /* ================================================================ */
  /*  Resource Gathering                                               */
  /* ================================================================ */

  async chopTree(treeName?: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "CHOP_TREE");
    if ("success" in state) return state;

    const tree = treeName
      ? findLocByName(state, treeName)
      : (state.nearbyLocs
          .filter((l) =>
            TREE_KEYWORDS.some((k) => l.name.toLowerCase().includes(k)),
          )
          .sort((a, b) => a.distance - b.distance)[0] ?? null);

    if (!tree) return fail("CHOP_TREE", "No tree found nearby");

    const invBefore = state.inventory.length;
    const opIdx = getOptionIndex(tree.options, "Chop down");

    try {
      await this.sdk.sendInteractLoc(tree.locId, opIdx);
    } catch {
      return fail("CHOP_TREE", `Failed to interact with ${tree.name}`);
    }

    // Wait for a woodcutting animation or an inventory change.
    try {
      await this.sdk.waitForState(
        (s) =>
          s.inventory.length > invBefore ||
          (!!s.player && s.player.animId !== -1),
        SHORT_TIMEOUT,
      );

      // If we got the anim, wait for item to appear in inventory.
      await this.sdk.waitForState(
        (s) => s.inventory.length > invBefore,
        DEFAULT_TIMEOUT,
      );
      return ok("CHOP_TREE", `Chopped ${tree.name}`, { locId: tree.locId });
    } catch {
      return fail("CHOP_TREE", `Timed out chopping ${tree.name}`);
    }
  }

  async mineRock(rockName?: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "MINE_ROCK");
    if ("success" in state) return state;

    const rock = rockName
      ? findLocByName(state, rockName)
      : (state.nearbyLocs
          .filter((l) =>
            ROCK_KEYWORDS.some((k) => l.name.toLowerCase().includes(k)),
          )
          .sort((a, b) => a.distance - b.distance)[0] ?? null);

    if (!rock) return fail("MINE_ROCK", "No rock or ore found nearby");

    const invBefore = state.inventory.length;
    const opIdx = getOptionIndex(rock.options, "Mine");

    try {
      await this.sdk.sendInteractLoc(rock.locId, opIdx);
    } catch {
      return fail("MINE_ROCK", `Failed to interact with ${rock.name}`);
    }

    try {
      await this.sdk.waitForState(
        (s) =>
          s.inventory.length > invBefore ||
          (!!s.player && s.player.animId !== -1),
        SHORT_TIMEOUT,
      );

      await this.sdk.waitForState(
        (s) => s.inventory.length > invBefore,
        DEFAULT_TIMEOUT,
      );
      return ok("MINE_ROCK", `Mined ${rock.name}`, { locId: rock.locId });
    } catch {
      return fail("MINE_ROCK", `Timed out mining ${rock.name}`);
    }
  }

  async fish(spotName?: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "FISH");
    if ("success" in state) return state;

    // Fishing spots are NPCs in the game engine.
    const spot = spotName
      ? findNpcByName(state, spotName)
      : (state.nearbyNpcs
          .filter((n) =>
            FISHING_KEYWORDS.some((k) => n.name.toLowerCase().includes(k)),
          )
          .sort((a, b) => a.distance - b.distance)[0] ?? null);

    if (!spot) return fail("FISH", "No fishing spot found nearby");

    const invBefore = state.inventory.length;

    try {
      await this.sdk.sendInteractNpc(spot.nid, 0);
    } catch {
      return fail("FISH", `Failed to interact with ${spot.name}`);
    }

    try {
      await this.sdk.waitForState(
        (s) => s.inventory.length > invBefore,
        DEFAULT_TIMEOUT,
      );
      return ok("FISH", `Caught fish at ${spot.name}`, { nid: spot.nid });
    } catch {
      return fail("FISH", `Timed out fishing at ${spot.name}`);
    }
  }

  /* ================================================================ */
  /*  Combat                                                           */
  /* ================================================================ */

  async eatFood(): Promise<ActionResult> {
    const state = requireState(this.sdk, "EAT_FOOD");
    if ("success" in state) return state;

    const food = state.inventory.find((item) =>
      FOOD_ITEMS.some((f) => item.name.toLowerCase().includes(f)),
    );
    if (!food) return fail("EAT_FOOD", "No food found in inventory");

    const hpBefore = state.player!.hp;

    try {
      await this.sdk.sendUseInventory(food.slot);
    } catch {
      return fail("EAT_FOOD", `Failed to eat ${food.name}`);
    }

    // Wait for HP to change.
    try {
      await this.sdk.waitForState(
        (s) => !!s.player && s.player.hp !== hpBefore,
        SHORT_TIMEOUT,
      );
      const after = this.sdk.getState();
      return ok("EAT_FOOD", `Ate ${food.name}`, {
        item: food.name,
        hpBefore,
        hpAfter: after?.player?.hp,
      });
    } catch {
      // HP may not have changed if already at max — still consumed the food.
      return ok("EAT_FOOD", `Used ${food.name} (HP may already be full)`, {
        item: food.name,
      });
    }
  }

  async setCombatStyle(styleIndex: number): Promise<ActionResult> {
    try {
      await this.sdk.sendSetCombatStyle(styleIndex);
      return ok("SET_COMBAT_STYLE", `Combat style set to index ${styleIndex}`, {
        style: styleIndex,
      });
    } catch {
      return fail(
        "SET_COMBAT_STYLE",
        `Failed to set combat style to ${styleIndex}`,
      );
    }
  }

  async castSpell(spellId: number, targetNid?: number): Promise<ActionResult> {
    try {
      await this.sdk.sendCastSpell(spellId, targetNid);
      await this.sdk.waitForTicks(2);
      return ok("CAST_SPELL", `Cast spell ${spellId}`, { spellId, targetNid });
    } catch {
      return fail("CAST_SPELL", `Failed to cast spell ${spellId}`);
    }
  }

  /* ================================================================ */
  /*  Inventory                                                        */
  /* ================================================================ */

  async dropItem(itemName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "DROP_ITEM");
    if ("success" in state) return state;

    const item = findInventoryItem(state, itemName);
    if (!item)
      return fail("DROP_ITEM", `Item "${itemName}" not found in inventory`);

    const invBefore = state.inventory.length;

    try {
      await this.sdk.sendDropItem(item.slot);
    } catch {
      return fail("DROP_ITEM", `Failed to drop ${item.name}`);
    }

    try {
      await this.sdk.waitForState(
        (s) =>
          s.inventory.length < invBefore ||
          !s.inventory.some((i) => i.slot === item.slot && i.id === item.id),
        SHORT_TIMEOUT,
      );
      return ok("DROP_ITEM", `Dropped ${item.name}`, {
        item: item.name,
        slot: item.slot,
      });
    } catch {
      return fail("DROP_ITEM", `Timed out dropping ${item.name}`);
    }
  }

  async useItem(itemName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "USE_ITEM");
    if ("success" in state) return state;

    const item = findInventoryItem(state, itemName);
    if (!item)
      return fail("USE_ITEM", `Item "${itemName}" not found in inventory`);

    try {
      await this.sdk.sendUseInventory(item.slot);
      await this.sdk.waitForTicks(2);
      return ok("USE_ITEM", `Used ${item.name}`, {
        item: item.name,
        slot: item.slot,
      });
    } catch {
      return fail("USE_ITEM", `Failed to use ${item.name}`);
    }
  }

  async pickupItem(itemName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "PICKUP_ITEM");
    if ("success" in state) return state;

    const ground = findGroundItemByName(state, itemName);
    if (!ground)
      return fail("PICKUP_ITEM", `Ground item "${itemName}" not found nearby`);

    if (isInventoryFull(state)) {
      return fail("PICKUP_ITEM", "Inventory is full");
    }

    const invBefore = state.inventory.length;

    try {
      await this.sdk.sendPickupItem(ground.id, ground.worldX, ground.worldZ);
    } catch {
      return fail("PICKUP_ITEM", `Failed to pick up ${ground.name}`);
    }

    try {
      await this.sdk.waitForState(
        (s) => s.inventory.length > invBefore,
        SHORT_TIMEOUT,
      );
      return ok("PICKUP_ITEM", `Picked up ${ground.name}`, {
        item: ground.name,
        count: ground.count,
      });
    } catch {
      return fail("PICKUP_ITEM", `Timed out picking up ${ground.name}`);
    }
  }

  async equipItem(itemName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "EQUIP_ITEM");
    if ("success" in state) return state;

    const item = findInventoryItem(state, itemName);
    if (!item)
      return fail("EQUIP_ITEM", `Item "${itemName}" not found in inventory`);

    const equipBefore = state.equipment.length;

    try {
      await this.sdk.sendEquipItem(item.slot);
    } catch {
      return fail("EQUIP_ITEM", `Failed to equip ${item.name}`);
    }

    try {
      await this.sdk.waitForState(
        (s) =>
          s.equipment.length > equipBefore ||
          s.equipment.some((e) => e.id === item.id),
        SHORT_TIMEOUT,
      );
      return ok("EQUIP_ITEM", `Equipped ${item.name}`, { item: item.name });
    } catch {
      return fail("EQUIP_ITEM", `Timed out equipping ${item.name}`);
    }
  }

  async unequipItem(itemName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "UNEQUIP_ITEM");
    if ("success" in state) return state;

    const lower = itemName.toLowerCase();
    const equipped = state.equipment.find((e) =>
      e.name.toLowerCase().includes(lower),
    );
    if (!equipped) {
      return fail("UNEQUIP_ITEM", `Item "${itemName}" not found in equipment`);
    }

    try {
      await this.sdk.sendUnequipItem(equipped.slot);
    } catch {
      return fail("UNEQUIP_ITEM", `Failed to unequip ${equipped.name}`);
    }

    try {
      await this.sdk.waitForState(
        (s) =>
          !s.equipment.some(
            (e) => e.slot === equipped.slot && e.id === equipped.id,
          ),
        SHORT_TIMEOUT,
      );
      return ok("UNEQUIP_ITEM", `Unequipped ${equipped.name}`, {
        item: equipped.name,
      });
    } catch {
      return fail("UNEQUIP_ITEM", `Timed out unequipping ${equipped.name}`);
    }
  }

  async useItemOnItem(
    itemName1: string,
    itemName2: string,
  ): Promise<ActionResult> {
    const state = requireState(this.sdk, "USE_ITEM_ON_ITEM");
    if ("success" in state) return state;

    const item1 = findInventoryItem(state, itemName1);
    if (!item1)
      return fail(
        "USE_ITEM_ON_ITEM",
        `Item "${itemName1}" not found in inventory`,
      );

    const item2 = findInventoryItem(state, itemName2);
    if (!item2)
      return fail(
        "USE_ITEM_ON_ITEM",
        `Item "${itemName2}" not found in inventory`,
      );

    try {
      await this.sdk.sendUseItemOnItem(item1.slot, item2.slot);
      await this.sdk.waitForTicks(3);
      return ok("USE_ITEM_ON_ITEM", `Used ${item1.name} on ${item2.name}`, {
        item1: item1.name,
        item2: item2.name,
      });
    } catch {
      return fail(
        "USE_ITEM_ON_ITEM",
        `Failed to use ${item1.name} on ${item2.name}`,
      );
    }
  }

  /* ================================================================ */
  /*  Banking                                                          */
  /* ================================================================ */

  async openBank(): Promise<ActionResult> {
    const state = requireState(this.sdk, "OPEN_BANK");
    if ("success" in state) return state;

    if (state.bank?.isOpen) {
      return ok("OPEN_BANK", "Bank is already open");
    }

    // Strategy 1: find a bank booth loc.
    const booth = state.nearbyLocs
      .filter((l) => {
        const n = l.name.toLowerCase();
        return (
          (n.includes("bank") && n.includes("booth")) || n === "bank booth"
        );
      })
      .sort((a, b) => a.distance - b.distance)[0];

    if (booth) {
      const opIdx = getOptionIndex(booth.options, "Bank");
      try {
        await this.sdk.sendInteractLoc(booth.locId, opIdx);
      } catch {
        // Fall through to NPC strategy.
      }

      try {
        await this.sdk.waitForState((s) => !!s.bank?.isOpen, SHORT_TIMEOUT);
        return ok("OPEN_BANK", "Opened bank via booth", { locId: booth.locId });
      } catch {
        // Fall through to NPC strategy.
      }
    }

    // Strategy 2: find a banker NPC.
    const banker = findNpcByName(state, "banker");
    if (!banker) {
      return fail("OPEN_BANK", "No bank booth or banker found nearby");
    }

    if (banker.distance > 2) {
      await this.walkTo(banker.worldX, banker.worldZ, "approach banker");
    }

    const opIdx = getOptionIndex(banker.options, "Bank");
    try {
      await this.sdk.sendInteractNpc(banker.nid, opIdx);
    } catch {
      return fail("OPEN_BANK", `Failed to interact with ${banker.name}`);
    }

    try {
      await this.sdk.waitForState((s) => !!s.bank?.isOpen, SHORT_TIMEOUT);
      return ok("OPEN_BANK", "Opened bank via banker", { nid: banker.nid });
    } catch {
      return fail(
        "OPEN_BANK",
        "Bank did not open after interacting with banker",
      );
    }
  }

  async closeBank(): Promise<ActionResult> {
    try {
      await this.sdk.sendCloseBank();
      await this.sdk.waitForTicks(2);
      return ok("CLOSE_BANK", "Closed bank");
    } catch {
      return fail("CLOSE_BANK", "Failed to close bank");
    }
  }

  async depositItem(itemName: string, count = 1): Promise<ActionResult> {
    const state = requireState(this.sdk, "DEPOSIT_ITEM");
    if ("success" in state) return state;

    if (!state.bank?.isOpen) {
      return fail("DEPOSIT_ITEM", "Bank is not open");
    }

    const item = findInventoryItem(state, itemName);
    if (!item)
      return fail("DEPOSIT_ITEM", `Item "${itemName}" not found in inventory`);

    const depositCount = Math.min(count, item.count);

    try {
      await this.sdk.sendDepositItem(item.slot, depositCount);
    } catch {
      return fail("DEPOSIT_ITEM", `Failed to deposit ${item.name}`);
    }

    try {
      await this.sdk.waitForState((s) => {
        const remaining = s.inventory.find(
          (i) => i.slot === item.slot && i.id === item.id,
        );
        return !remaining || remaining.count < item.count;
      }, SHORT_TIMEOUT);
      return ok("DEPOSIT_ITEM", `Deposited ${depositCount}x ${item.name}`, {
        item: item.name,
        count: depositCount,
      });
    } catch {
      return fail("DEPOSIT_ITEM", `Timed out depositing ${item.name}`);
    }
  }

  async withdrawItem(itemName: string, count = 1): Promise<ActionResult> {
    const state = requireState(this.sdk, "WITHDRAW_ITEM");
    if ("success" in state) return state;

    if (!state.bank?.isOpen) {
      return fail("WITHDRAW_ITEM", "Bank is not open");
    }

    const bankItem = findBankItemByName(state, itemName);
    if (!bankItem)
      return fail("WITHDRAW_ITEM", `Item "${itemName}" not found in bank`);

    if (isInventoryFull(state)) {
      return fail("WITHDRAW_ITEM", "Inventory is full");
    }

    const withdrawCount = Math.min(count, bankItem.count);

    try {
      await this.sdk.sendWithdrawItem(bankItem.slot, withdrawCount);
    } catch {
      return fail("WITHDRAW_ITEM", `Failed to withdraw ${bankItem.name}`);
    }

    try {
      await this.sdk.waitForState(
        (s) => s.inventory.some((i) => i.id === bankItem.id),
        SHORT_TIMEOUT,
      );
      return ok(
        "WITHDRAW_ITEM",
        `Withdrew ${withdrawCount}x ${bankItem.name}`,
        {
          item: bankItem.name,
          count: withdrawCount,
        },
      );
    } catch {
      return fail("WITHDRAW_ITEM", `Timed out withdrawing ${bankItem.name}`);
    }
  }

  /* ================================================================ */
  /*  Shopping                                                         */
  /* ================================================================ */

  async openShop(npcName: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "OPEN_SHOP");
    if ("success" in state) return state;

    if (state.shop?.isOpen) {
      return ok("OPEN_SHOP", "Shop is already open");
    }

    const npc = findNpcByName(state, npcName);
    if (!npc) return fail("OPEN_SHOP", `NPC "${npcName}" not found nearby`);

    if (npc.distance > 2) {
      await this.walkTo(npc.worldX, npc.worldZ, `approach ${npc.name}`);
    }

    const _opIdx = getOptionIndex(npc.options, "Trade");

    try {
      await this.sdk.sendOpenShop(npc.nid);
    } catch {
      return fail("OPEN_SHOP", `Failed to trade with ${npc.name}`);
    }

    try {
      await this.sdk.waitForState((s) => !!s.shop?.isOpen, SHORT_TIMEOUT);
      const after = this.sdk.getState();
      return ok("OPEN_SHOP", `Opened ${after?.shop?.name ?? "shop"}`, {
        nid: npc.nid,
        shopName: after?.shop?.name,
        itemCount: after?.shop?.items.length,
      });
    } catch {
      return fail(
        "OPEN_SHOP",
        `Shop did not open after trading with ${npc.name}`,
      );
    }
  }

  async closeShop(): Promise<ActionResult> {
    try {
      await this.sdk.sendCloseShop();
      await this.sdk.waitForTicks(2);
      return ok("CLOSE_SHOP", "Closed shop");
    } catch {
      return fail("CLOSE_SHOP", "Failed to close shop");
    }
  }

  async buyFromShop(itemName: string, count = 1): Promise<ActionResult> {
    const state = requireState(this.sdk, "BUY_FROM_SHOP");
    if ("success" in state) return state;

    if (!state.shop?.isOpen) {
      return fail("BUY_FROM_SHOP", "Shop is not open");
    }

    const shopItem = findShopItemByName(state, itemName);
    if (!shopItem)
      return fail("BUY_FROM_SHOP", `Item "${itemName}" not found in shop`);

    if (shopItem.stock < count) {
      return fail(
        "BUY_FROM_SHOP",
        `Only ${shopItem.stock} ${shopItem.name} in stock (wanted ${count})`,
      );
    }

    if (isInventoryFull(state)) {
      return fail("BUY_FROM_SHOP", "Inventory is full");
    }

    try {
      await this.sdk.sendBuyItem(shopItem.slot, count);
    } catch {
      return fail("BUY_FROM_SHOP", `Failed to buy ${shopItem.name}`);
    }

    try {
      await this.sdk.waitForState(
        (s) => s.inventory.some((i) => i.id === shopItem.id),
        SHORT_TIMEOUT,
      );
      return ok("BUY_FROM_SHOP", `Bought ${count}x ${shopItem.name}`, {
        item: shopItem.name,
        count,
        price: shopItem.price,
      });
    } catch {
      return fail("BUY_FROM_SHOP", `Timed out buying ${shopItem.name}`);
    }
  }

  async sellToShop(itemName: string, count = 1): Promise<ActionResult> {
    const state = requireState(this.sdk, "SELL_TO_SHOP");
    if ("success" in state) return state;

    if (!state.shop?.isOpen) {
      return fail("SELL_TO_SHOP", "Shop is not open");
    }

    const item = findInventoryItem(state, itemName);
    if (!item)
      return fail("SELL_TO_SHOP", `Item "${itemName}" not found in inventory`);

    const sellCount = Math.min(count, item.count);

    try {
      await this.sdk.sendSellItem(item.slot, sellCount);
    } catch {
      return fail("SELL_TO_SHOP", `Failed to sell ${item.name}`);
    }

    try {
      await this.sdk.waitForState((s) => {
        const remaining = s.inventory.find(
          (i) => i.slot === item.slot && i.id === item.id,
        );
        return !remaining || remaining.count < item.count;
      }, SHORT_TIMEOUT);
      return ok("SELL_TO_SHOP", `Sold ${sellCount}x ${item.name}`, {
        item: item.name,
        count: sellCount,
      });
    } catch {
      return fail("SELL_TO_SHOP", `Timed out selling ${item.name}`);
    }
  }

  /* ================================================================ */
  /*  Crafting / Processing                                            */
  /* ================================================================ */

  async burnLogs(): Promise<ActionResult> {
    const state = requireState(this.sdk, "BURN_LOGS");
    if ("success" in state) return state;

    const tinderbox = findInventoryItem(state, "tinderbox");
    if (!tinderbox) return fail("BURN_LOGS", "No tinderbox in inventory");

    const logs = findInventoryItem(state, "logs");
    if (!logs) return fail("BURN_LOGS", "No logs in inventory");

    try {
      await this.sdk.sendUseItemOnItem(tinderbox.slot, logs.slot);
    } catch {
      return fail("BURN_LOGS", "Failed to use tinderbox on logs");
    }

    // Wait for logs to leave inventory (consumed by fire).
    try {
      await this.sdk.waitForState(
        (s) =>
          !s.inventory.some((i) => i.slot === logs.slot && i.id === logs.id),
        DEFAULT_TIMEOUT,
      );
      return ok("BURN_LOGS", `Burned ${logs.name}`, { item: logs.name });
    } catch {
      return fail("BURN_LOGS", "Timed out waiting for logs to burn");
    }
  }

  async cookFood(rawFoodName?: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "COOK_FOOD");
    if ("success" in state) return state;

    const rawFood = rawFoodName
      ? findInventoryItem(state, rawFoodName)
      : findInventoryItem(state, "raw");
    if (!rawFood) return fail("COOK_FOOD", "No raw food in inventory");

    // Find a fire or range loc.
    const cookSurface = state.nearbyLocs
      .filter((l) => {
        const n = l.name.toLowerCase();
        return n.includes("fire") || n.includes("range") || n.includes("stove");
      })
      .sort((a, b) => a.distance - b.distance)[0];

    if (!cookSurface) return fail("COOK_FOOD", "No fire or range found nearby");

    try {
      await this.sdk.sendUseItemOnLoc(rawFood.slot, cookSurface.locId);
    } catch {
      return fail(
        "COOK_FOOD",
        `Failed to use ${rawFood.name} on ${cookSurface.name}`,
      );
    }

    // Wait for the raw food to be consumed or transformed.
    try {
      await this.sdk.waitForState(
        (s) =>
          !s.inventory.some(
            (i) => i.slot === rawFood.slot && i.id === rawFood.id,
          ),
        DEFAULT_TIMEOUT,
      );
      return ok("COOK_FOOD", `Cooked ${rawFood.name}`, {
        rawFood: rawFood.name,
        cookSurface: cookSurface.name,
      });
    } catch {
      return fail("COOK_FOOD", `Timed out cooking ${rawFood.name}`);
    }
  }

  async fletchLogs(): Promise<ActionResult> {
    const state = requireState(this.sdk, "FLETCH_LOGS");
    if ("success" in state) return state;

    const knife = findInventoryItem(state, "knife");
    if (!knife) return fail("FLETCH_LOGS", "No knife in inventory");

    const logs = findInventoryItem(state, "logs");
    if (!logs) return fail("FLETCH_LOGS", "No logs in inventory");

    try {
      await this.sdk.sendUseItemOnItem(knife.slot, logs.slot);
      await this.sdk.waitForTicks(3);
      return ok("FLETCH_LOGS", `Used knife on ${logs.name}`, {
        item: logs.name,
      });
    } catch {
      return fail("FLETCH_LOGS", "Failed to use knife on logs");
    }
  }

  async craftLeather(): Promise<ActionResult> {
    const state = requireState(this.sdk, "CRAFT_LEATHER");
    if ("success" in state) return state;

    const needle = findInventoryItem(state, "needle");
    if (!needle) return fail("CRAFT_LEATHER", "No needle in inventory");

    const leather = findInventoryItem(state, "leather");
    if (!leather) return fail("CRAFT_LEATHER", "No leather in inventory");

    try {
      await this.sdk.sendUseItemOnItem(needle.slot, leather.slot);
      await this.sdk.waitForTicks(3);
      return ok("CRAFT_LEATHER", `Used needle on ${leather.name}`, {
        item: leather.name,
      });
    } catch {
      return fail("CRAFT_LEATHER", "Failed to use needle on leather");
    }
  }

  async smithAtAnvil(itemName?: string): Promise<ActionResult> {
    const state = requireState(this.sdk, "SMITH_AT_ANVIL");
    if ("success" in state) return state;

    const hammer = findInventoryItem(state, "hammer");
    if (!hammer) return fail("SMITH_AT_ANVIL", "No hammer in inventory");

    const bar = itemName
      ? findInventoryItem(state, itemName)
      : findInventoryItem(state, "bar");
    if (!bar) return fail("SMITH_AT_ANVIL", "No metal bar in inventory");

    const anvil = findLocByName(state, "anvil");
    if (!anvil) return fail("SMITH_AT_ANVIL", "No anvil found nearby");

    try {
      await this.sdk.sendUseItemOnLoc(bar.slot, anvil.locId);
      await this.sdk.waitForTicks(3);
      return ok("SMITH_AT_ANVIL", `Used ${bar.name} on anvil`, {
        bar: bar.name,
        locId: anvil.locId,
      });
    } catch {
      return fail("SMITH_AT_ANVIL", `Failed to smith ${bar.name} at anvil`);
    }
  }

  async useItemOnObject(
    itemName: string,
    objectName: string,
  ): Promise<ActionResult> {
    const state = requireState(this.sdk, "USE_ITEM_ON_OBJECT");
    if ("success" in state) return state;

    const item = findInventoryItem(state, itemName);
    if (!item)
      return fail(
        "USE_ITEM_ON_OBJECT",
        `Item "${itemName}" not found in inventory`,
      );

    const loc = findLocByName(state, objectName);
    if (!loc)
      return fail(
        "USE_ITEM_ON_OBJECT",
        `Object "${objectName}" not found nearby`,
      );

    try {
      await this.sdk.sendUseItemOnLoc(item.slot, loc.locId);
      await this.sdk.waitForTicks(3);
      return ok("USE_ITEM_ON_OBJECT", `Used ${item.name} on ${loc.name}`, {
        item: item.name,
        object: loc.name,
        locId: loc.locId,
      });
    } catch {
      return fail(
        "USE_ITEM_ON_OBJECT",
        `Failed to use ${item.name} on ${loc.name}`,
      );
    }
  }
}

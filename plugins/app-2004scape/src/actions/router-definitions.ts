export interface Rs2004SubactionDefinition {
  name: string;
  dispatch: string;
  legacyAction: string;
  params: string;
  description: string;
}

export interface Rs2004RouterDefinition {
  name: string;
  description: string;
  descriptionCompressed: string;
  subactions: readonly Rs2004SubactionDefinition[];
}

export const RS_2004_ACTION_ROUTER_DEFINITIONS = [
  {
    name: "RS_2004_MOVEMENT",
    description:
      "Route 2004scape movement actions. Use subaction to walk or handle path blockers.",
    descriptionCompressed: "2004scape movement router.",
    subactions: [
      {
        name: "walk_to",
        dispatch: "walkTo",
        legacyAction: "WALK_TO",
        params: "destination: name OR x: N, z: N",
        description: "Walk to a coordinate or named destination.",
      },
      {
        name: "open_door",
        dispatch: "openDoor",
        legacyAction: "OPEN_DOOR",
        params: "no params",
        description: "Open the nearest door or gate.",
      },
    ],
  },
  {
    name: "RS_2004_INTERACTION",
    description:
      "Route 2004scape object, ground-item, and general world interactions.",
    descriptionCompressed: "2004scape world interaction router.",
    subactions: [
      {
        name: "interact_object",
        dispatch: "interactObject",
        legacyAction: "INTERACT_OBJECT",
        params: "object: name, option: action",
        description: "Interact with a nearby object.",
      },
      {
        name: "pickup_item",
        dispatch: "pickupItem",
        legacyAction: "PICKUP_ITEM",
        params: "item: name",
        description: "Pick up a nearby ground item.",
      },
      {
        name: "use_item_on_object",
        dispatch: "useItemOnObject",
        legacyAction: "USE_ITEM_ON_OBJECT",
        params: "item: name, object: name",
        description: "Use an inventory item on a world object.",
      },
    ],
  },
  {
    name: "RS_2004_COMBAT",
    description:
      "Route 2004scape combat actions, including attacks, healing, style, and spells.",
    descriptionCompressed: "2004scape combat router.",
    subactions: [
      {
        name: "attack_npc",
        dispatch: "attackNpc",
        legacyAction: "ATTACK_NPC",
        params: "npc: name",
        description: "Attack a nearby NPC by name.",
      },
      {
        name: "eat_food",
        dispatch: "eatFood",
        legacyAction: "EAT_FOOD",
        params: "no params",
        description: "Eat the first food found.",
      },
      {
        name: "set_combat_style",
        dispatch: "setCombatStyle",
        legacyAction: "SET_COMBAT_STYLE",
        params: "style: 0=Atk 1=Str 2=Def 3=Ctrl",
        description: "Set the active combat style.",
      },
      {
        name: "cast_spell",
        dispatch: "castSpell",
        legacyAction: "CAST_SPELL",
        params: "spell: spellId, target: npcNid optional",
        description: "Cast a spell, optionally at an NPC.",
      },
    ],
  },
  {
    name: "RS_2004_INVENTORY",
    description:
      "Route 2004scape inventory item actions for dropping, using, wearing, and combining items.",
    descriptionCompressed: "2004scape inventory router.",
    subactions: [
      {
        name: "drop_item",
        dispatch: "dropItem",
        legacyAction: "DROP_ITEM",
        params: "item: name",
        description: "Drop an inventory item by name.",
      },
      {
        name: "use_item",
        dispatch: "useItem",
        legacyAction: "USE_ITEM",
        params: "item: name",
        description: "Use an inventory item by name.",
      },
      {
        name: "equip_item",
        dispatch: "equipItem",
        legacyAction: "EQUIP_ITEM",
        params: "item: name",
        description: "Equip an inventory item by name.",
      },
      {
        name: "unequip_item",
        dispatch: "unequipItem",
        legacyAction: "UNEQUIP_ITEM",
        params: "item: name",
        description: "Unequip a worn item by name.",
      },
      {
        name: "use_item_on_item",
        dispatch: "useItemOnItem",
        legacyAction: "USE_ITEM_ON_ITEM",
        params: "item1: name, item2: name",
        description: "Use one inventory item on another.",
      },
    ],
  },
  {
    name: "RS_2004_BANKING",
    description:
      "Route 2004scape banking actions for opening, closing, depositing, and withdrawing.",
    descriptionCompressed: "2004scape banking router.",
    subactions: [
      {
        name: "open_bank",
        dispatch: "openBank",
        legacyAction: "OPEN_BANK",
        params: "no params",
        description: "Find and open the nearest bank.",
      },
      {
        name: "close_bank",
        dispatch: "closeBank",
        legacyAction: "CLOSE_BANK",
        params: "no params",
        description: "Close the active bank interface.",
      },
      {
        name: "deposit_item",
        dispatch: "depositItem",
        legacyAction: "DEPOSIT_ITEM",
        params: "item: name, count: N optional",
        description: "Deposit an item into the bank.",
      },
      {
        name: "withdraw_item",
        dispatch: "withdrawItem",
        legacyAction: "WITHDRAW_ITEM",
        params: "item: name, count: N optional",
        description: "Withdraw an item from the bank.",
      },
    ],
  },
  {
    name: "RS_2004_SHOP",
    description:
      "Route 2004scape shop actions for opening, closing, buying, and selling.",
    descriptionCompressed: "2004scape shop router.",
    subactions: [
      {
        name: "open_shop",
        dispatch: "openShop",
        legacyAction: "OPEN_SHOP",
        params: "npc: shopkeeper name",
        description: "Open a shop by talking to a shopkeeper.",
      },
      {
        name: "close_shop",
        dispatch: "closeShop",
        legacyAction: "CLOSE_SHOP",
        params: "no params",
        description: "Close the active shop interface.",
      },
      {
        name: "buy_from_shop",
        dispatch: "buyFromShop",
        legacyAction: "BUY_FROM_SHOP",
        params: "item: name, count: N",
        description: "Buy an item from the active shop.",
      },
      {
        name: "sell_to_shop",
        dispatch: "sellToShop",
        legacyAction: "SELL_TO_SHOP",
        params: "item: name, count: N",
        description: "Sell an item to the active shop.",
      },
    ],
  },
  {
    name: "RS_2004_SKILLING",
    description:
      "Route 2004scape skilling actions for gathering, production, and thieving.",
    descriptionCompressed: "2004scape skilling router.",
    subactions: [
      {
        name: "chop_tree",
        dispatch: "chopTree",
        legacyAction: "CHOP_TREE",
        params: "tree: type optional",
        description: "Chop a nearby tree.",
      },
      {
        name: "mine_rock",
        dispatch: "mineRock",
        legacyAction: "MINE_ROCK",
        params: "rock: type optional",
        description: "Mine a nearby rock.",
      },
      {
        name: "fish",
        dispatch: "fish",
        legacyAction: "FISH",
        params: "spot: type optional",
        description: "Fish at a nearby fishing spot.",
      },
      {
        name: "burn_logs",
        dispatch: "burnLogs",
        legacyAction: "BURN_LOGS",
        params: "no params",
        description: "Use a tinderbox on logs.",
      },
      {
        name: "cook_food",
        dispatch: "cookFood",
        legacyAction: "COOK_FOOD",
        params: "food: raw food name optional",
        description: "Cook raw food.",
      },
      {
        name: "fletch_logs",
        dispatch: "fletchLogs",
        legacyAction: "FLETCH_LOGS",
        params: "no params",
        description: "Fletch logs.",
      },
      {
        name: "craft_leather",
        dispatch: "craftLeather",
        legacyAction: "CRAFT_LEATHER",
        params: "no params",
        description: "Craft leather.",
      },
      {
        name: "smith_at_anvil",
        dispatch: "smithAtAnvil",
        legacyAction: "SMITH_AT_ANVIL",
        params: "item: item to smith optional",
        description: "Smith an item at an anvil.",
      },
      {
        name: "pickpocket_npc",
        dispatch: "pickpocketNpc",
        legacyAction: "PICKPOCKET_NPC",
        params: "npc: name",
        description: "Pickpocket a nearby NPC.",
      },
    ],
  },
  {
    name: "RS_2004_DIALOGUE",
    description:
      "Route 2004scape NPC conversation and dialog-option actions.",
    descriptionCompressed: "2004scape dialogue router.",
    subactions: [
      {
        name: "talk_to_npc",
        dispatch: "talkToNpc",
        legacyAction: "TALK_TO_NPC",
        params: "npc: name",
        description: "Talk to a nearby NPC by name.",
      },
      {
        name: "navigate_dialog",
        dispatch: "navigateDialog",
        legacyAction: "NAVIGATE_DIALOG",
        params: "option: 1-based index",
        description: "Choose a dialog option.",
      },
    ],
  },
] as const satisfies readonly Rs2004RouterDefinition[];

export type Rs2004RouterActionName =
  (typeof RS_2004_ACTION_ROUTER_DEFINITIONS)[number]["name"];

export interface ResolvedRs2004Action {
  routerName: Rs2004RouterActionName;
  subaction: string;
  dispatch: string;
  legacyAction: string;
}

function normalizeActionName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

function normalizeSubactionName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

const RESOLVED_BY_ROUTER_AND_SUBACTION = new Map<
  string,
  ResolvedRs2004Action
>();
const RESOLVED_BY_LEGACY_ACTION = new Map<string, ResolvedRs2004Action>();

for (const router of RS_2004_ACTION_ROUTER_DEFINITIONS) {
  for (const subaction of router.subactions) {
    const resolved: ResolvedRs2004Action = {
      routerName: router.name as Rs2004RouterActionName,
      subaction: subaction.name,
      dispatch: subaction.dispatch,
      legacyAction: subaction.legacyAction,
    };
    RESOLVED_BY_ROUTER_AND_SUBACTION.set(
      `${router.name}:${subaction.name}`,
      resolved,
    );
    RESOLVED_BY_LEGACY_ACTION.set(subaction.legacyAction, resolved);
  }
}

export function isRs2004RouterActionName(actionName: unknown): boolean {
  const normalized = normalizeActionName(actionName);
  return RS_2004_ACTION_ROUTER_DEFINITIONS.some(
    (router) => router.name === normalized,
  );
}

export function resolveRs2004RouterAction(
  actionName: unknown,
  subactionName?: unknown,
): ResolvedRs2004Action | null {
  const normalizedAction = normalizeActionName(actionName);
  const normalizedSubaction = normalizeSubactionName(subactionName);

  if (normalizedSubaction) {
    const resolved = RESOLVED_BY_ROUTER_AND_SUBACTION.get(
      `${normalizedAction}:${normalizedSubaction}`,
    );
    if (resolved) return resolved;
  }

  return RESOLVED_BY_LEGACY_ACTION.get(normalizedAction) ?? null;
}

export function formatRs2004RouterPrompt(): string {
  return RS_2004_ACTION_ROUTER_DEFINITIONS.map((router) => {
    const subactions = router.subactions
      .map(
        (subaction) =>
          `    - ${subaction.name}: ${subaction.params}; ${subaction.description}`,
      )
      .join("\n");
    return `  ${router.name}: choose subaction\n${subactions}`;
  }).join("\n");
}

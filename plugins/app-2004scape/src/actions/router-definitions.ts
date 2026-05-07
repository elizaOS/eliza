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
    name: "SKILL_OP",
    description:
      "Route 2004scape skilling actions: chop, mine, fish, burn, cook, fletch, craft, smith.",
    descriptionCompressed:
      "Skill ops: chop, mine, fish, burn, cook, fletch, craft, smith.",
    subactions: [
      {
        name: "chop",
        dispatch: "chopTree",
        legacyAction: "CHOP_TREE",
        params: "target: tree type optional",
        description: "Chop a nearby tree.",
      },
      {
        name: "mine",
        dispatch: "mineRock",
        legacyAction: "MINE_ROCK",
        params: "target: rock type optional",
        description: "Mine a nearby rock.",
      },
      {
        name: "fish",
        dispatch: "fish",
        legacyAction: "FISH",
        params: "target: spot type optional",
        description: "Fish at a nearby fishing spot.",
      },
      {
        name: "burn",
        dispatch: "burnLogs",
        legacyAction: "BURN_LOGS",
        params: "no params",
        description: "Use a tinderbox on logs.",
      },
      {
        name: "cook",
        dispatch: "cookFood",
        legacyAction: "COOK_FOOD",
        params: "target: raw food name optional",
        description: "Cook raw food.",
      },
      {
        name: "fletch",
        dispatch: "fletchLogs",
        legacyAction: "FLETCH_LOGS",
        params: "no params",
        description: "Fletch logs.",
      },
      {
        name: "craft",
        dispatch: "craftLeather",
        legacyAction: "CRAFT_LEATHER",
        params: "no params",
        description: "Craft leather.",
      },
      {
        name: "smith",
        dispatch: "smithAtAnvil",
        legacyAction: "SMITH_AT_ANVIL",
        params: "target: item to smith optional",
        description: "Smith an item at an anvil.",
      },
    ],
  },
  {
    name: "INVENTORY_OP",
    description:
      "Route 2004scape inventory operations: drop, pickup, equip, unequip, use, use-on-item, use-on-object.",
    descriptionCompressed:
      "Inventory ops: drop, pickup, equip, unequip, use, use-on-item, use-on-object.",
    subactions: [
      {
        name: "drop",
        dispatch: "dropItem",
        legacyAction: "DROP_ITEM",
        params: "item: name",
        description: "Drop an inventory item by name.",
      },
      {
        name: "pickup",
        dispatch: "pickupItem",
        legacyAction: "PICKUP_ITEM",
        params: "item: name",
        description: "Pick up a nearby ground item.",
      },
      {
        name: "equip",
        dispatch: "equipItem",
        legacyAction: "EQUIP_ITEM",
        params: "item: name",
        description: "Equip an inventory item by name.",
      },
      {
        name: "unequip",
        dispatch: "unequipItem",
        legacyAction: "UNEQUIP_ITEM",
        params: "item: name",
        description: "Unequip a worn item by name.",
      },
      {
        name: "use",
        dispatch: "useItem",
        legacyAction: "USE_ITEM",
        params: "item: name",
        description: "Use an inventory item by name.",
      },
      {
        name: "use-on-item",
        dispatch: "useItemOnItem",
        legacyAction: "USE_ITEM_ON_ITEM",
        params: "item: name, target: other item name",
        description: "Use one inventory item on another.",
      },
      {
        name: "use-on-object",
        dispatch: "useItemOnObject",
        legacyAction: "USE_ITEM_ON_OBJECT",
        params: "item: name, target: object name",
        description: "Use an inventory item on a world object.",
      },
    ],
  },
  {
    name: "BANK_OP",
    description:
      "Route 2004scape banking operations: open, close, deposit, withdraw.",
    descriptionCompressed: "Bank ops: open, close, deposit, withdraw.",
    subactions: [
      {
        name: "open",
        dispatch: "openBank",
        legacyAction: "OPEN_BANK",
        params: "no params",
        description: "Find and open the nearest bank.",
      },
      {
        name: "close",
        dispatch: "closeBank",
        legacyAction: "CLOSE_BANK",
        params: "no params",
        description: "Close the active bank interface.",
      },
      {
        name: "deposit",
        dispatch: "depositItem",
        legacyAction: "DEPOSIT_ITEM",
        params: "item: name, count: N optional",
        description: "Deposit an item into the bank.",
      },
      {
        name: "withdraw",
        dispatch: "withdrawItem",
        legacyAction: "WITHDRAW_ITEM",
        params: "item: name, count: N optional",
        description: "Withdraw an item from the bank.",
      },
    ],
  },
  {
    name: "SHOP_OP",
    description: "Route 2004scape shop operations: open, close, buy, sell.",
    descriptionCompressed: "Shop ops: open, close, buy, sell.",
    subactions: [
      {
        name: "open",
        dispatch: "openShop",
        legacyAction: "OPEN_SHOP",
        params: "npc: shopkeeper name",
        description: "Open a shop by talking to a shopkeeper.",
      },
      {
        name: "close",
        dispatch: "closeShop",
        legacyAction: "CLOSE_SHOP",
        params: "no params",
        description: "Close the active shop interface.",
      },
      {
        name: "buy",
        dispatch: "buyFromShop",
        legacyAction: "BUY_FROM_SHOP",
        params: "item: name, count: N",
        description: "Buy an item from the active shop.",
      },
      {
        name: "sell",
        dispatch: "sellToShop",
        legacyAction: "SELL_TO_SHOP",
        params: "item: name, count: N",
        description: "Sell an item to the active shop.",
      },
    ],
  },
  {
    name: "COMBAT_OP",
    description:
      "Route 2004scape combat operations: attack, cast-spell, set-style, eat.",
    descriptionCompressed: "Combat ops: attack, cast-spell, set-style, eat.",
    subactions: [
      {
        name: "attack",
        dispatch: "attackNpc",
        legacyAction: "ATTACK_NPC",
        params: "target: npc name",
        description: "Attack a nearby NPC by name.",
      },
      {
        name: "cast-spell",
        dispatch: "castSpell",
        legacyAction: "CAST_SPELL",
        params: "spell: spellId, target: npcNid optional",
        description: "Cast a spell, optionally at an NPC.",
      },
      {
        name: "set-style",
        dispatch: "setCombatStyle",
        legacyAction: "SET_COMBAT_STYLE",
        params: "style: 0=Atk 1=Str 2=Def 3=Ctrl",
        description: "Set the active combat style.",
      },
      {
        name: "eat",
        dispatch: "eatFood",
        legacyAction: "EAT_FOOD",
        params: "no params",
        description: "Eat the first food found.",
      },
    ],
  },
  {
    name: "INTERACT_OP",
    description:
      "Route 2004scape world interactions: talk, navigate-dialog, interact-object, open-door, pickpocket.",
    descriptionCompressed:
      "Interact ops: talk, navigate-dialog, interact-object, open-door, pickpocket.",
    subactions: [
      {
        name: "talk",
        dispatch: "talkToNpc",
        legacyAction: "TALK_TO_NPC",
        params: "npc: name",
        description: "Talk to a nearby NPC by name.",
      },
      {
        name: "navigate-dialog",
        dispatch: "navigateDialog",
        legacyAction: "NAVIGATE_DIALOG",
        params: "option: 1-based index",
        description: "Choose a dialog option.",
      },
      {
        name: "interact-object",
        dispatch: "interactObject",
        legacyAction: "INTERACT_OBJECT",
        params: "object: name, option: action optional",
        description: "Interact with a nearby object.",
      },
      {
        name: "open-door",
        dispatch: "openDoor",
        legacyAction: "OPEN_DOOR",
        params: "no params",
        description: "Open the nearest door or gate.",
      },
      {
        name: "pickpocket",
        dispatch: "pickpocketNpc",
        legacyAction: "PICKPOCKET_NPC",
        params: "npc: name",
        description: "Pickpocket a nearby NPC.",
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
    .replace(/[_\s]+/g, "-")
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
  const walkTo =
    "  RS_2004_WALK_TO: walk to a coordinate or named destination\n    params: destination: name OR x: N, z: N";
  const routers = RS_2004_ACTION_ROUTER_DEFINITIONS.map((router) => {
    const subactions = router.subactions
      .map(
        (subaction) =>
          `    - ${subaction.name}: ${subaction.params}; ${subaction.description}`,
      )
      .join("\n");
    return `  ${router.name}: choose subaction\n${subactions}`;
  }).join("\n");
  return `${walkTo}\n${routers}`;
}

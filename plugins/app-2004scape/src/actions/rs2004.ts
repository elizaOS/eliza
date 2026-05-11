/**
 * RS_2004 — single Pattern C parent action that absorbs every old leaf
 * + router from the previous surface (RS_2004_WALK_TO, SKILL_OP /
 * RS_2004_INVENTORY_OP / BANK_OP / SHOP_OP / COMBAT_OP / INTERACT_OP).
 *
 * Op set (drawn from the source dispatcher in
 * `services/game-service.ts:dispatchAction`):
 *
 *   walk_to          { destination?, x?, z?, reason? }
 *   chop|mine|fish   { target? } / chop a tree, mine a rock, fish a spot
 *   burn|fletch|craft { } / no-arg craft loops
 *   cook             { target? } / target = raw food name
 *   smith            { target? } / target = item to smith
 *   drop|pickup|equip|unequip|use { item }
 *   use_on_item      { item, target } / item-on-item
 *   use_on_object    { item, target } / item-on-world-object
 *   open|close       { } when target=bank ; { npc } when target=shop
 *   deposit|withdraw { item, count? }
 *   buy|sell         { item, count }
 *   attack           { target } / target = npc name
 *   cast_spell       { spell, target? } / target = npc nid
 *   set_style        { style: 0..3 }
 *   eat              { }
 *   talk             { npc }
 *   navigate_dialog  { option: 1-based index }
 *   interact_object  { object, option? }
 *   open_door        { }
 *   pickpocket       { npc }
 *
 * For `open` / `close` the target context (bank vs shop) is taken from
 * an explicit `target: "bank" | "shop"` field, falling back to the
 * presence of `npc` (shop) or absence (bank).
 *
 * Old action names live as similes for trace continuity.
 */

import {
  parseJSONObjectFromText,
  type Action,
  type ActionResult as CoreActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ActionResult as PluginActionResult } from "../sdk/types.js";
import { getCurrentLlmResponse } from "../shared-state.js";
import { getRsSdkGameService } from "./game-service.js";

type ParamsRecord = Record<string, unknown>;

type Rs2004Result = CoreActionResult & {
  action: string;
  message: string;
  details?: Record<string, unknown>;
};

type Rs2004Op =
  | "walk_to"
  | "chop"
  | "mine"
  | "fish"
  | "burn"
  | "cook"
  | "fletch"
  | "craft"
  | "smith"
  | "drop"
  | "pickup"
  | "equip"
  | "unequip"
  | "use"
  | "use_on_item"
  | "use_on_object"
  | "open"
  | "close"
  | "deposit"
  | "withdraw"
  | "buy"
  | "sell"
  | "attack"
  | "cast_spell"
  | "set_style"
  | "eat"
  | "talk"
  | "navigate_dialog"
  | "interact_object"
  | "open_door"
  | "pickpocket";

const RS_2004_OPS: readonly Rs2004Op[] = [
  "walk_to",
  "chop",
  "mine",
  "fish",
  "burn",
  "cook",
  "fletch",
  "craft",
  "smith",
  "drop",
  "pickup",
  "equip",
  "unequip",
  "use",
  "use_on_item",
  "use_on_object",
  "open",
  "close",
  "deposit",
  "withdraw",
  "buy",
  "sell",
  "attack",
  "cast_spell",
  "set_style",
  "eat",
  "talk",
  "navigate_dialog",
  "interact_object",
  "open_door",
  "pickpocket",
] as const;

/**
 * Map an LLM-supplied op string (any case, with `-` or `_`, with or
 * without legacy verbs like `CHOP_TREE`) to the canonical op enum.
 */
function normalizeOp(value: unknown): Rs2004Op | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  switch (normalized) {
    case "walk_to":
    case "rs_2004_walk_to":
    case "walkto":
    case "move_to":
    case "goto":
      return "walk_to";
    case "chop":
    case "chop_tree":
    case "choptree":
      return "chop";
    case "mine":
    case "mine_rock":
      return "mine";
    case "fish":
      return "fish";
    case "burn":
    case "burn_logs":
      return "burn";
    case "cook":
    case "cook_food":
      return "cook";
    case "fletch":
    case "fletch_logs":
      return "fletch";
    case "craft":
    case "craft_leather":
      return "craft";
    case "smith":
    case "smith_at_anvil":
      return "smith";
    case "drop":
    case "drop_item":
      return "drop";
    case "pickup":
    case "pickup_item":
      return "pickup";
    case "equip":
    case "equip_item":
      return "equip";
    case "unequip":
    case "unequip_item":
      return "unequip";
    case "use":
    case "use_item":
      return "use";
    case "use_on_item":
    case "useonitem":
    case "use_item_on_item":
      return "use_on_item";
    case "use_on_object":
    case "useonobject":
    case "use_item_on_object":
      return "use_on_object";
    case "open":
    case "open_bank":
    case "open_shop":
      return "open";
    case "close":
    case "close_bank":
    case "close_shop":
      return "close";
    case "deposit":
    case "deposit_item":
      return "deposit";
    case "withdraw":
    case "withdraw_item":
      return "withdraw";
    case "buy":
    case "buy_from_shop":
      return "buy";
    case "sell":
    case "sell_to_shop":
      return "sell";
    case "attack":
    case "attack_npc":
      return "attack";
    case "cast_spell":
    case "castspell":
      return "cast_spell";
    case "set_style":
    case "set_combat_style":
      return "set_style";
    case "eat":
    case "eat_food":
      return "eat";
    case "talk":
    case "talk_to_npc":
      return "talk";
    case "navigate_dialog":
    case "dialog":
      return "navigate_dialog";
    case "interact_object":
    case "interact":
      return "interact_object";
    case "open_door":
    case "door":
      return "open_door";
    case "pickpocket":
    case "pickpocket_npc":
      return "pickpocket";
    default:
      return RS_2004_OPS.includes(normalized as Rs2004Op)
        ? (normalized as Rs2004Op)
        : null;
  }
}

/**
 * Map a normalized op + params record to the underlying SDK action
 * dispatch type, with parameter-shape normalization (alias mapping,
 * default counts) baked in. Returns null when bank/shop context can't
 * be resolved for `open`/`close`.
 */
function resolveDispatch(
  op: Rs2004Op,
  params: ParamsRecord,
): { dispatch: string; params: ParamsRecord } | null {
  const target = String(params.target ?? "").toLowerCase();
  const next = mapAliases({ ...params }, op);

  switch (op) {
    case "walk_to":
      return { dispatch: "walkTo", params: next };
    case "chop":
      return { dispatch: "chopTree", params: next };
    case "mine":
      return { dispatch: "mineRock", params: next };
    case "fish":
      return { dispatch: "fish", params: next };
    case "burn":
      return { dispatch: "burnLogs", params: next };
    case "cook":
      return { dispatch: "cookFood", params: next };
    case "fletch":
      return { dispatch: "fletchLogs", params: next };
    case "craft":
      return { dispatch: "craftLeather", params: next };
    case "smith":
      return { dispatch: "smithAtAnvil", params: next };
    case "drop":
      return { dispatch: "dropItem", params: next };
    case "pickup":
      return { dispatch: "pickupItem", params: next };
    case "equip":
      return { dispatch: "equipItem", params: next };
    case "unequip":
      return { dispatch: "unequipItem", params: next };
    case "use":
      return { dispatch: "useItem", params: next };
    case "use_on_item":
      return { dispatch: "useItemOnItem", params: next };
    case "use_on_object":
      return { dispatch: "useItemOnObject", params: next };
    case "open": {
      // target=shop OR npc present → openShop; otherwise openBank.
      if (target === "shop" || next.npc != null || next.npcName != null) {
        return { dispatch: "openShop", params: next };
      }
      return { dispatch: "openBank", params: next };
    }
    case "close": {
      if (target === "shop") return { dispatch: "closeShop", params: next };
      return { dispatch: "closeBank", params: next };
    }
    case "deposit": {
      next.count = next.count ?? -1;
      return { dispatch: "depositItem", params: next };
    }
    case "withdraw": {
      next.count = next.count ?? 1;
      return { dispatch: "withdrawItem", params: next };
    }
    case "buy":
      return { dispatch: "buyFromShop", params: next };
    case "sell":
      return { dispatch: "sellToShop", params: next };
    case "attack":
      return { dispatch: "attackNpc", params: next };
    case "cast_spell":
      return { dispatch: "castSpell", params: next };
    case "set_style":
      return { dispatch: "setCombatStyle", params: next };
    case "eat":
      return { dispatch: "eatFood", params: next };
    case "talk":
      return { dispatch: "talkToNpc", params: next };
    case "navigate_dialog":
      return { dispatch: "navigateDialog", params: next };
    case "interact_object":
      return { dispatch: "interactObject", params: next };
    case "open_door":
      return { dispatch: "openDoor", params: next };
    case "pickpocket":
      return { dispatch: "pickpocketNpc", params: next };
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Apply the same field-aliasing the previous router did, plus the
 * `target` → typed-name expansion that varies by dispatch.
 */
function mapAliases(params: ParamsRecord, op: Rs2004Op): ParamsRecord {
  if (params.npc && !params.npcName) params.npcName = params.npc;
  if (params.item && !params.itemName) params.itemName = params.item;
  if (params.object && !params.objectName) params.objectName = params.object;
  if (params.spell && !params.spellId) params.spellId = params.spell;
  if (params.item1 && !params.itemName1) params.itemName1 = params.item1;
  if (params.item2 && !params.itemName2) params.itemName2 = params.item2;

  if (params.target != null) {
    switch (op) {
      case "chop":
        params.treeName ??= params.target;
        break;
      case "mine":
        params.rockName ??= params.target;
        break;
      case "fish":
        params.spotName ??= params.target;
        break;
      case "cook":
        params.rawFoodName ??= params.target;
        break;
      case "smith":
        params.itemName ??= params.target;
        break;
      case "attack":
        params.npcName ??= params.target;
        break;
      case "cast_spell":
        params.targetNid ??= params.target;
        break;
      case "use_on_item":
        params.itemName2 ??= params.target;
        break;
      case "use_on_object":
        params.objectName ??= params.target;
        break;
      default:
        break;
    }
  }

  return params;
}

function isRecord(value: unknown): value is ParamsRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function coerceParamValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  return trimmed;
}

function paramsFromText(text: string): ParamsRecord {
  const parsed = parseJSONObjectFromText(text) as ParamsRecord | null;
  if (!parsed) return {};
  const nested = isRecord(parsed.params) ? parsed.params : {};
  const params: ParamsRecord = { ...parsed, ...nested };
  for (const [key, value] of Object.entries(params)) {
    params[key] = coerceParamValue(value);
  }
  return params;
}

function paramsFromOptions(options: unknown): ParamsRecord {
  if (!isRecord(options)) return {};
  const handlerOptions = options as HandlerOptions;
  if (isRecord(handlerOptions.parameters)) {
    return handlerOptions.parameters;
  }
  return options;
}

function resolveActionText(message: Memory | undefined | null): string {
  const messageText = message?.content?.text;
  if (typeof messageText === "string" && messageText.trim().length > 0) {
    return messageText;
  }
  return getCurrentLlmResponse();
}

function toResult(result: PluginActionResult): Rs2004Result {
  return {
    success: result.success,
    text: result.message,
    action: result.action,
    message: result.message,
    details: result.details,
    data: { action: result.action, message: result.message },
  };
}

function errorResult(message: string): Rs2004Result {
  return {
    success: false,
    text: message,
    action: "RS_2004",
    message,
    error: message,
    data: { action: "RS_2004", message },
  };
}

const SIMILES = [
  "RS_2004_WALK_TO",
  "MOVE_TO",
  "GOTO",
  "SKILL",
  "SKILL",
  "RS_2004_INVENTORY",
  "RS_2004_INVENTORY",
  "INVENTORY",
  "BANK",
  "BANK",
  "SHOP",
  "SHOP",
  "COMBAT",
  "COMBAT",
  "INTERACT",
  "INTERACT",
  "CHOP_TREE",
  "MINE_ROCK",
  "FISH",
  "BURN_LOGS",
  "COOK_FOOD",
  "FLETCH_LOGS",
  "CRAFT_LEATHER",
  "SMITH_AT_ANVIL",
  "DROP_ITEM",
  "PICKUP_ITEM",
  "EQUIP_ITEM",
  "UNEQUIP_ITEM",
  "USE_ITEM",
  "USE_ITEM_ON_ITEM",
  "USE_ITEM_ON_OBJECT",
  "OPEN_BANK",
  "CLOSE_BANK",
  "DEPOSIT_ITEM",
  "WITHDRAW_ITEM",
  "OPEN_SHOP",
  "CLOSE_SHOP",
  "BUY_FROM_SHOP",
  "SELL_TO_SHOP",
  "ATTACK_NPC",
  "CAST_SPELL",
  "SET_COMBAT_STYLE",
  "EAT_FOOD",
  "TALK_TO_NPC",
  "NAVIGATE_DIALOG",
  "INTERACT_OBJECT",
  "OPEN_DOOR",
  "PICKPOCKET_NPC",
];

export const rs2004Action: Action = {
  name: "RS_2004",
  description:
    "Drive the 2004scape game agent. Choose one action (walk_to, chop, mine, fish, burn, cook, fletch, craft, smith, drop, pickup, equip, unequip, use, use_on_item, use_on_object, open, close, deposit, withdraw, buy, sell, attack, cast_spell, set_style, eat, talk, navigate_dialog, interact_object, open_door, pickpocket). For open/close, set target='bank' or target='shop' (or include npc to imply shop). Per-action fields go in params.",
  descriptionCompressed:
    "rs_2004 actions (walk_to, skills, inventory, bank, shop, combat, interact)",
  contexts: ["game", "automation", "world", "state"],
  roleGate: { minRole: "ADMIN" },
  similes: SIMILES,
  examples: [],
  parameters: [
    {
      name: "action",
      description: "Operation to run.",
      descriptionCompressed: "Action.",
      required: true,
      schema: { type: "string", enum: [...RS_2004_OPS] },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      descriptionCompressed: "Legacy op alias.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "params",
      description:
        "Optional JSON object containing the fields required by the chosen op.",
      descriptionCompressed: "Action fields.",
      required: false,
      schema: { type: "object" },
    },
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return runtime.getService("rs_2004scape") != null;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: HandlerOptions | ParamsRecord | undefined,
    callback?: HandlerCallback,
  ): Promise<Rs2004Result> => {
    const service = getRsSdkGameService(runtime);
    if (!service) {
      const text = "Game service not available.";
      callback?.({ text, action: "RS_2004" });
      return errorResult(text);
    }

    const params = {
      ...paramsFromText(resolveActionText(message)),
      ...paramsFromOptions(options),
    };
    const op = normalizeOp(
      params.action ??
        params.op ??
        params.subaction ??
        params.actionType ??
        params.type,
    );
    if (!op) {
      const text = `RS_2004 requires a valid action: one of ${RS_2004_OPS.join("|")}.`;
      callback?.({ text, action: "RS_2004" });
      return errorResult(text);
    }

    const dispatch = resolveDispatch(op, params);
    if (!dispatch) {
      const text = `RS_2004 ${op} could not resolve to a dispatch.`;
      callback?.({ text, action: "RS_2004" });
      return errorResult(text);
    }

    try {
      const result = await service.executeAction(
        dispatch.dispatch,
        dispatch.params,
      );
      callback?.({ text: result.message, action: "RS_2004" });
      return toResult(result);
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown RS_2004 failure.";
      const text = `RS_2004 ${op} failed: ${errMessage}`;
      callback?.({ text, action: "RS_2004" });
      return { ...errorResult(text), error: errMessage };
    }
  },
};

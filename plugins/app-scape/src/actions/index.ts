/**
 * Action registry for `@elizaos/app-scape`.
 *
 * Single planner-facing parent: SCAPE (Pattern C). Old leaves
 * (SCAPE_WALK_TO, ATTACK_NPC, CHAT_PUBLIC, JOURNAL_OP, INVENTORY_OP,
 * SET_GOAL, COMPLETE_GOAL, REMEMBER, EAT_FOOD, DROP_ITEM) live as
 * similes on `SCAPE`.
 */

import type { Action } from "@elizaos/core";

import { scapeAction } from "./scape.js";

export { scapeAction } from "./scape.js";

export const scapeActions: Action[] = [scapeAction];

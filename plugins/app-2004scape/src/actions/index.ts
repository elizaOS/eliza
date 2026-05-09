/**
 * Action registry for `@elizaos/app-2004scape`.
 *
 * Single planner-facing parent: `RS_2004` (Pattern C). It absorbs the
 * old `RS_2004_WALK_TO` standalone plus the six router actions
 * (SKILL_OP / RS_2004_INVENTORY_OP / BANK_OP / SHOP_OP / COMBAT_OP /
 * INTERACT_OP) and the legacy per-op verbs they routed (CHOP_TREE,
 * MINE_ROCK, ATTACK_NPC, etc.). All of those names live as similes on
 * `RS_2004` for trace continuity.
 */

import type { Action } from "@elizaos/core";

import { rs2004Action } from "./rs2004.js";

export { rs2004Action } from "./rs2004.js";

export const rsSdkActions: Action[] = [rs2004Action];

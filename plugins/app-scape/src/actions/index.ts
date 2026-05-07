/**
 * Action registry for `@elizaos/app-scape`.
 *
 * Five planner-facing actions:
 *   - SCAPE_WALK_TO (standalone)
 *   - ATTACK_NPC    (standalone)
 *   - CHAT_PUBLIC   (standalone)
 *   - JOURNAL_OP    (router: set-goal | complete-goal | remember)
 *   - INVENTORY_OP  (router: eat | drop)
 */

import type { Action } from "@elizaos/core";

import { attackNpc } from "./attack-npc.js";
import { chatPublic } from "./chat-public.js";
import { scapeInventoryAction, scapeJournalAction } from "./routers.js";
import { walkTo } from "./walk-to.js";

export { attackNpc } from "./attack-npc.js";
export { chatPublic } from "./chat-public.js";
export {
  scapeInventoryAction,
  scapeJournalAction,
  scapeRouterActions,
} from "./routers.js";
export { walkTo } from "./walk-to.js";
export {
  SCAPE_ACTION_ROUTER_DEFINITIONS,
  formatScapeRouterPrompt,
  isScapeRouterActionName,
  resolveScapeRouterAction,
} from "./router-definitions.js";

export const scapeActions: Action[] = [
  walkTo,
  attackNpc,
  chatPublic,
  scapeJournalAction,
  scapeInventoryAction,
];

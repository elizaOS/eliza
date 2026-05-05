/**
 * Action registry for `@elizaos/app-scape`.
 *
 * The planner-facing surface is intentionally compressed into routers so
 * overlapping game verbs do not collide with other RuneScape-like apps.
 */

import type { Action } from "@elizaos/core";

export {
  scapeGameAction,
  scapeJournalAction,
  scapeRouterActions,
} from "./routers.js";
export {
  SCAPE_ACTION_ROUTER_DEFINITIONS,
  formatScapeRouterPrompt,
  isScapeRouterActionName,
  resolveScapeRouterAction,
} from "./router-definitions.js";

import { scapeRouterActions } from "./routers.js";

export const scapeActions: Action[] = scapeRouterActions;

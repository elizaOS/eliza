/**
 * Action registry for `@elizaos/app-scape`.
 *
 * PR 5 ships a 5-action toolbelt — all of these are wired through the
 * xRSPS `BotSdkActionRouter` to real game services. No deferred stubs.
 *
 * Adding a new action is a three-step process:
 *   1. Add the action file under `actions/`.
 *   2. Append to the `scapeActions` array below.
 *   3. Extend the server's `AnyActionFrame` union and
 *      `BotSdkActionRouter.dispatch` switch.
 *   4. Update `ACTION_LIST` in `services/game-service.ts` so the LLM
 *      prompt surfaces the new tool.
 */

import type { Action } from "@elizaos/core";

import { attackNpc } from "./attack-npc.js";
import { chatPublic } from "./chat-public.js";
import { completeGoal } from "./complete-goal.js";
import { dropItem } from "./drop-item.js";
import { eatFood } from "./eat-food.js";
import { remember } from "./remember.js";
import { setGoal } from "./set-goal.js";
import { walkTo } from "./walk-to.js";

export const scapeActions: Action[] = [
  // In-world
  walkTo,
  chatPublic,
  attackNpc,
  dropItem,
  eatFood,
  // Agent-self / Scape Journal
  setGoal,
  completeGoal,
  remember,
];

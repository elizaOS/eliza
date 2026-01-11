/**
 * Action exports for Roblox plugin
 */

import type { Action } from "@elizaos/core";
import sendGameMessage from "./sendGameMessage";
import executeGameAction from "./executeGameAction";
import getPlayerInfo from "./getPlayerInfo";

export const robloxActions: Action[] = [
  sendGameMessage,
  executeGameAction,
  getPlayerInfo,
];

export { sendGameMessage, executeGameAction, getPlayerInfo };



import {
  ownerOrAdminOrNewHooks,
  onlySelfOrPublicGames,
  onlySelfUser,
} from "./hooks.js";
import getConfToken from "./getConfToken.js";

import { deleteOldSession } from "./scheduled.js";

export const main = async ({ store, schedules, functions, hooks }) => {
  // Add hooks
  hooks.before = [ownerOrAdminOrNewHooks, onlySelfUser];
  hooks.after = [ownerOrAdminOrNewHooks, onlySelfOrPublicGames];
  hooks.beforeFile = [ownerOrAdminOrNewHooks];

  functions.getConfToken = getConfToken;

  // Declare stores
  await store.createOrUpdateBox("game", { security: "readOnly" });
  await store.createOrUpdateBox("room", { security: "public" });
  await store.createOrUpdateBox("session", { security: "public" });
  await store.createOrUpdateBox("user", { security: "private" });
  await store.createOrUpdateBox("files", { security: "private" });

  // Add schedules
  schedules["daily"] = [deleteOldSession(store)];

  console.log("Setup loaded with session");
};

export default main;

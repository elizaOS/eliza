import { throwError } from "./utils.js";

export const ownerOrAdminOrNewHooks = async (context) => {
  let existingGame = null;

  const { userId, store, resourceId, body, boxId, method } = context;

  // Is it the `game` box ?
  if (boxId !== "game") {
    return context;
  }

  // Is it a modification action ?
  if (!["POST", "UPDATE", "DELETE"].includes(method)) {
    return context;
  }

  // From here it's a game modification...

  if (!userId) {
    throwError(
      "Game creation/modification not allowed for unauthenticated users",
      403
    );
  }

  const nextContext = {
    ...context,
    allow: true,
    body: { ...body, owner: userId },
  };

  if (!resourceId) {
    // Creation
    return nextContext;
  }

  try {
    existingGame = await store.get("game", resourceId);
  } catch {
    console.log("Game not found");
    // Creation but with resourceId
    return nextContext;
  }

  let isAdmin = false;
  try {
    const currentUser = await store.get("user", userId);
    isAdmin = Boolean(currentUser?.isAdmin);
  } catch (e) {
    if (e.statusCode !== 404) {
      throw e;
    }
  }

  if (existingGame.owner !== userId && !isAdmin) {
    throwError("Modification allowed only for owner or Admin", 403);
  }

  const owner = existingGame.owner || userId;

  // Update with good user (and force user)
  return {
    ...nextContext,
    body: { ...body, owner: owner },
  };
};

export const onlySelfOrPublicGames = async (context) => {
  const { boxId, userId, method, response, resourceId, store } = context;
  if (boxId !== "game") {
    return context;
  }

  if (!["GET"].includes(method) || resourceId) {
    return context;
  }

  // Get current user account
  let userIsAdmin = false;
  try {
    const { isAdmin = false } = await store.get("user", userId);
    userIsAdmin = isAdmin;
  } catch (e) {
    if (e.statusCode !== 404) {
      throw e;
    }
  }

  const newContext = { ...context };

  newContext.response = response.filter(
    ({ board: { published } = {}, owner } = {}) =>
      published || owner === userId || userIsAdmin
  );

  return newContext;
};

export const onlySelfUser = async (context) => {
  const { boxId, userId, method, resourceId, store } = context;
  if (boxId !== "user") {
    return context;
  }

  if (method !== "GET") {
    throwError("Method not allowed", 405);
  }

  if (resourceId !== userId) {
    throwError("You can only access your account", 403);
  }

  // Create user account if missing
  try {
    await store.get("user", userId);
  } catch (e) {
    if (e.statusCode === 404) {
      await store.save("user", userId, {});
    } else {
      throw e;
    }
  }

  return { ...context, allow: true };
};

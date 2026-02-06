console.log("Save game");

const throwError = (message, code = 400) => {
  const errorObject = new Error(message);
  errorObject.statusCode = code;
  throw errorObject;
};

const main = async ({ store, id, userId, body }) => {
  let existingGame = null;

  if (!userId) {
    throwError("Game creation not allowed for unauthenticated users", 403);
  }

  try {
    existingGame = await store.get("game", id);
  } catch {
    console.log("Game not found");
  }

  if (existingGame && existingGame.owner && existingGame.owner !== userId) {
    console.log("Forbidden");
    throwError("Modification allowed only for owner", 403);
  }

  let { owner = userId } = body;
  const result = await store.save("game", id, { ...body, owner });
  return result;
};

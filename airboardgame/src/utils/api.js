import { API_ENDPOINT, IS_PRODUCTION, API_BASE } from "./settings";

import testGame from "../games/testGame";
import perfGame from "../games/perfGame";
import unpublishedGame from "../games/unpublishedGame";
import { uid } from "./";

const oldUploadURI = `${API_ENDPOINT}/file`;
const gameURI = `${API_ENDPOINT}/store/game`;
const sessionURI = `${API_ENDPOINT}/store/session`;
const roomURI = `${API_ENDPOINT}/store/room`;
const userURI = `${API_ENDPOINT}/store/user`;
const execURI = `${API_ENDPOINT}/execute`;
const authURI = `${API_ENDPOINT}/auth`;

export const uploadImage = async (namespace, file) => {
  const payload = new FormData();
  payload.append("file", file);
  const result = await fetch(`${oldUploadURI}/${namespace}/`, {
    method: "POST",
    body: payload, // this sets the `Content-Type` header to `multipart/form-data`
  });

  return await result.text();
};

export const uploadResourceImage = async (boxId, resourceId, file) => {
  const uploadGameURI = `${API_ENDPOINT}/store/${boxId}/${resourceId}/file`;

  const payload = new FormData();
  payload.append("file", file);

  const result = await fetch(`${uploadGameURI}/`, {
    method: "POST",
    body: payload, // this sets the `Content-Type` header to `multipart/form-data`
    credentials: "include",
  });

  if (result.status === 404) {
    throw new Error("Resource not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }

  return await result.text();
};

export const listResourceImage = async (boxId, resourceId) => {
  const uploadGameURI = `${API_ENDPOINT}/store/${boxId}/${resourceId}/file`;

  const result = await fetch(`${uploadGameURI}/`, {
    method: "GET",
    credentials: "include",
  });

  if (result.status === 404) {
    throw new Error("Files not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }

  return await result.json();
};

export const deleteResourceImage = async (filePath) => {
  const result = await fetch(`${API_BASE}/${filePath}`, {
    method: "DELETE",
    credentials: "include",
  });

  return await result.json();
};

export const getBestTranslationFromConfig = (
  {
    translations = [],
    defaultLanguage,
    defaultName,
    defaultDescription,
    name,
    info,
  } = {},
  langs
) => {
  const translationsMap = {
    [defaultLanguage || "en"]: {
      name: defaultName || name,
      description: defaultDescription || info,
    },
  };

  translations.forEach((translation) => {
    translationsMap[translation.language] = translation;
  });

  for (let lang in langs) {
    if (translationsMap[langs[lang]]) {
      return translationsMap[langs[lang]];
    }
  }

  return translationsMap[defaultLanguage || "en"];
};

const demoGame = {
  id: "demo",
  owner: "nobody",
  board: {
    published: true,
    defaultName: "How to play?",
    bgType: "default",
    playerCount: [],
    duration: [],
    gridSize: 1,
    defaultLanguage: "en",
    materialLanguage: "Multi-lang",
    defaultBaseline: "Learn how to play with Airboardgame",
    imageUrl: "/game_assets/default.png",
    keepTitle: true,
    defaultDescription:
      "# Demo game\n\nThis is a demo game to learn how to play with Airboardgame.\n\nFor other games, you can find useful information about the game like the creator name or the rules.",
    translations: [
      {
        language: "fr",
        name: "Comment jouer ?",
        baseline: "Apprenez à jouer avec Airboardgame",
        description:
          "# Démonstration\n\nCe jeu vous permet d'apprendre à jouer avec Airboardgame.\n\nPour les autres jeux, vous trouverez dans cette section différentes choses utiles comme le nom de l'auteur ou les règles.",
      },
    ],
  },
};

export const getGames = async () => {
  const fetchParams = new URLSearchParams({
    fields: "_id,board,owner",
    limit: 2000,
  });

  let gameList = [];

  const result = await fetch(`${gameURI}?${"" + fetchParams}`, {
    credentials: "include",
  });

  if (result.status === 200) {
    const serverGames = await result.json();

    gameList = serverGames.map((game) => ({
      id: game._id,
      owner: game.owner,
      board: game.board,
      url: `${gameURI}/${game._id}`,
    }));
  }
  if (!IS_PRODUCTION || import.meta.env.VITE_CI) {
    gameList = [testGame, perfGame, unpublishedGame, ...gameList];
  }

  gameList = [demoGame, ...gameList];

  return gameList;
};

const fetchGame = async (url) => {
  const result = await fetch(url, {
    credentials: "include",
  });

  if (result.status === 404) {
    throw new Error("Game not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }

  return await result.json();
};

const fixGame = (game) => {
  // Add id if missing
  game.items = game.items.map((item) => ({
    id: uid(),
    ...item,
  }));

  game.availableItems = game.availableItems.map((item) => ({
    id: uid(),
    ...item,
  }));
  return game;
};

export const getGame = async (gameId) => {
  let game;

  switch (gameId) {
    // Demo games
    case "test":
      game = testGame;
      break;
    case "perf":
      game = perfGame;
      break;
    case "unpublished":
      game = unpublishedGame;
      break;
    // Real games
    default:
      game = await fetchGame(`${gameURI}/${gameId}`);
  }

  return fixGame(game);
};

export const createGame = async (data) => {
  const newGameId = uid();
  const result = await updateGame(newGameId, data);
  return result;
};

export const getOrCreateGame = async (gameId, defaultData) => {
  const result = await fetch(`${gameURI}/${gameId}`, {
    credentials: "include",
  });
  if (result.status === 404) {
    return fixGame(await updateGame(gameId, defaultData));
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return fixGame(await result.json());
};

export const updateGame = async (gameId, data) => {
  // fake games
  if (["test", "perf", "unpublished", "demo"].includes(gameId)) {
    return data;
  }
  const result = await fetch(`${gameURI}/${gameId}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
    credentials: "include",
  });
  if (result.status === 404) {
    throw new Error("Resource not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return await result.json();
};

export const deleteGame = async (gameId) => {
  const result = await fetch(`${gameURI}/${gameId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (result.status === 404) {
    throw new Error("Resource not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return await result.json();
};

export const getSession = async (id) => {
  const result = await fetch(`${sessionURI}/${id}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    credentials: "include",
  });
  if (result.status === 404) {
    throw new Error("Resource not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return await result.json();
};

export const updateSession = async (id, data) => {
  const result = await fetch(`${sessionURI}/${id}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
    credentials: "include",
  });
  if (result.status === 404) {
    throw new Error("Resource not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return await result.json();
};

export const getRoom = async (id) => {
  const result = await fetch(`${roomURI}/${id}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    credentials: "include",
  });
  if (result.status === 404) {
    throw new Error("Resource not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return await result.json();
};

export const updateRoom = async (id, data) => {
  const result = await fetch(`${roomURI}/${id}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
    credentials: "include",
  });
  if (result.status === 404) {
    throw new Error("Resource not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return await result.json();
};

export const sendAuthToken = async (email) => {
  const result = await fetch(`${authURI}/`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userEmail: email }),
    credentials: "include",
  });

  if (result.status !== 200) {
    throw new Error("Can't send token");
  }
};

export const login = async (userHash, token) => {
  const result = await fetch(`${authURI}/verify/${userHash}/${token}`, {
    credentials: "include",
  });

  if (result.status !== 200) {
    throw new Error("Auth failed");
  }
};

export const checkAuthentication = async () => {
  const result = await fetch(`${authURI}/check`, {
    credentials: "include",
  });

  if (result.status !== 200) {
    return false;
  }
  return true;
};

export const logout = async () => {
  const result = await fetch(`${authURI}/logout/`, {
    credentials: "include",
  });

  if (result.status !== 200) {
    throw new Error("Logout failed");
  }
};

export const getConfToken = async (session) => {
  const result = await fetch(`${execURI}/getConfToken?session=${session}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  if (result.status === 404) {
    throw new Error("Webconference not enabled");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return await result.json();
};

export const getAccount = async (id) => {
  const result = await fetch(`${userURI}/${id}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    credentials: "include",
  });
  if (result.status === 404) {
    throw new Error("Resource not found");
  }
  if (result.status === 403) {
    throw new Error("Forbidden");
  }
  if (result.status >= 300) {
    throw new Error("Server error");
  }
  return await result.json();
};

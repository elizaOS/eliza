import { type Character, logger, validateCharacterConfig } from "@elizaos/core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { character as defaultCharacter } from "../characters/eliza";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function tryLoadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`Error loading file ${filePath}: ${e}`);
  }
}

export async function loadCharactersFromUrl(url: string): Promise<Character[]> {
  try {
    const response = await fetch(url);
    const responseJson = await response.json();

    let characters: Character[] = [];
    if (Array.isArray(responseJson)) {
      characters = await Promise.all(
        responseJson.map((character) => jsonToCharacter(character))
      );
    } else {
      const character = await jsonToCharacter(responseJson);
      characters.push(character);
    }
    return characters;
  } catch (e) {
    logger.error(`Error loading character(s) from ${url}: ${e}`);
    process.exit(1);
  }
}

export async function jsonToCharacter(
  character: any
): Promise<Character> {
  validateCharacterConfig(character);

  // .id isn't really valid
  const characterId = character.id || character.name;
  const characterPrefix = `CHARACTER.${characterId
    .toUpperCase()
    .replace(/ /g, "_")}.`;
  const characterSettings = Object.entries(process.env)
    .filter(([key]) => key.startsWith(characterPrefix))
    .reduce((settings, [key, value]) => {
      const settingKey = key.slice(characterPrefix.length);
      return { ...settings, [settingKey]: value };
    }, {});
  if (Object.keys(characterSettings).length > 0) {
    character.settings = character.settings || {};
    character.secrets = {
      ...characterSettings,
      ...(character.secrets || {}),
      ...(character.settings?.secrets || {}),
    };
  }

  return character;
}

export async function loadCharacter(filePath: string): Promise<Character> {
  const content = tryLoadFile(filePath);
  if (!content) {
    throw new Error(`Character file not found: ${filePath}`);
  }
  const character = JSON.parse(content);
  return jsonToCharacter(character);
}

function handleCharacterLoadError(path: string, error: unknown): never {
  logger.error(`Error loading character from ${path}: ${error}`);
  throw new Error(`Error loading character from ${path}: ${error}`);
}

async function safeLoadCharacter(path: string): Promise<Character> {
  try {
    const character = await loadCharacter(path);
    logger.info(`Successfully loaded character from: ${path}`);
    return character;
  } catch (e) {
    return handleCharacterLoadError(path, e);
  }
}

export async function loadCharacterTryPath(characterPath: string): Promise<Character> {

  if (characterPath.startsWith("http")) {
    const characters = await loadCharactersFromUrl(characterPath);
    return characters[0];
  }

  const pathsToTry = [
    characterPath,
    path.resolve(process.cwd(), "..", "..", characterPath),
    path.resolve(process.cwd(), characterPath),
    path.resolve(process.cwd(), "agent", characterPath),
    path.resolve(__dirname, characterPath),
    path.resolve(__dirname, "characters", path.basename(characterPath)),
    path.resolve(__dirname, "../characters", path.basename(characterPath)),
    path.resolve(__dirname, "../../characters", path.basename(characterPath)),
  ];

  for (const tryPath of pathsToTry) {
    const content = tryLoadFile(tryPath);
    if (content !== null) {
      return safeLoadCharacter(tryPath);
    }
  }

  return handleCharacterLoadError(
    characterPath,
    "File not found in any of the expected locations"
  );
}

function commaSeparatedStringToArray(commaSeparated: string): string[] {
  return commaSeparated?.split(",").map((value) => value.trim());
}

async function readCharactersFromStorage(
  characterPaths: string[]
): Promise<string[]> {
  try {
    const uploadDir = path.join(process.cwd(), "data", "characters");
    await fs.promises.mkdir(uploadDir, { recursive: true });
    const fileNames = await fs.promises.readdir(uploadDir);
    for (const fileName of fileNames) {
      characterPaths.push(path.join(uploadDir, fileName));
    }
  } catch (err) {
    logger.error(`Error reading directory: ${(err as Error).message}`);
  }

  return characterPaths;
}

export const hasValidRemoteUrls = () =>
  process.env.REMOTE_CHARACTER_URLS &&
  process.env.REMOTE_CHARACTER_URLS !== "" &&
  process.env.REMOTE_CHARACTER_URLS.startsWith("http");

export async function loadCharacters(charactersArg: string): Promise<Character[]> {
  let characterPaths = commaSeparatedStringToArray(charactersArg);
  const loadedCharacters: Character[] = [];

  if (process.env.USE_CHARACTER_STORAGE === "true") {
    characterPaths = await readCharactersFromStorage(characterPaths);
  }

  if (characterPaths?.length > 0) {
    for (const characterPath of characterPaths) {
      const character = await loadCharacterTryPath(characterPath);
      loadedCharacters.push(character);
    }
  }

  if (hasValidRemoteUrls()) {
    logger.info("Loading characters from remote URLs");
    const characterUrls = commaSeparatedStringToArray(
      process.env.REMOTE_CHARACTER_URLS
    );
    for (const characterUrl of characterUrls) {
      const characters = await loadCharactersFromUrl(characterUrl);
      loadedCharacters.push(...characters);
    }
  }

  if (loadedCharacters.length === 0) {
    logger.info("No characters found, using default character");
    loadedCharacters.push(defaultCharacter);
  }

  return loadedCharacters;
} 



export const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
      const uploadDir = path.join(process.cwd(), "data", "uploads");
      // Create the directory if it doesn't exist
      if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

// some people have more memory than disk.io
export const upload = multer({ storage /*: multer.memoryStorage() */ });

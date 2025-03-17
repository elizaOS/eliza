import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Character, logger } from '@elizaos/core';
import multer from 'multer';
import { character as defaultCharacter } from '../characters/eliza';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Attempts to load a file from the given file path.
 *
 * @param {string} filePath - The path to the file to load.
 * @returns {string | null} The contents of the file as a string, or null if an error occurred.
 * @throws {Error} If an error occurs while loading the file.
 */
export function tryLoadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`Error loading file ${filePath}: ${e}`);
  }
}

/**
 * Load characters from a specified URL and return them as an array of Character objects.
 * @param {string} url - The URL from which to load character data.
 * @returns {Promise<Character[]>} - A promise that resolves with an array of Character objects.
 */
export async function loadCharactersFromUrl(url: string): Promise<Character[]> {
  try {
    const response = await fetch(url);
    const responseJson = await response.json();

    let characters: Character[] = [];
    if (Array.isArray(responseJson)) {
      characters = await Promise.all(responseJson.map((character) => jsonToCharacter(character)));
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

/**
 * Converts a JSON object representing a character into a Character object with additional settings and secrets.
 *
 * @param {any} character - The input JSON object representing a character.
 * @returns {Promise<Character>} - A Promise that resolves to a Character object.
 */
export async function jsonToCharacter(character: any): Promise<Character> {
  // .id isn't really valid
  const characterId = character.id || character.name;
  const characterPrefix = `CHARACTER.${characterId.toUpperCase().replace(/ /g, '_')}.`;
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

/**
 * Loads a character from the specified file path.
 *
 * @param {string} filePath - The path to the character file.
 * @returns {Promise<Character>} A Promise that resolves to the loaded Character object.
 * @throws {Error} If the character file is not found.
 */
export async function loadCharacter(filePath: string): Promise<Character> {
  const content = tryLoadFile(filePath);
  if (!content) {
    throw new Error(`Character file not found: ${filePath}`);
  }
  const character = JSON.parse(content);
  return jsonToCharacter(character);
}

/**
 * Handles errors when loading a character from a specific path.
 *
 * @param {string} path - The path from which the character is being loaded.
 * @param {unknown} error - The error that occurred during the loading process.
 * @returns {never}
 */
function handleCharacterLoadError(path: string, error: unknown): never {
  logger.error(`Error loading character from ${path}: ${error}`);
  throw new Error(`Error loading character from ${path}: ${error}`);
}

/**
 * Asynchronously loads a character from the specified path while handling any potential errors.
 *
 * @param {string} path - The path to load the character from.
 * @returns {Promise<Character>} A promise that resolves to the loaded character.
 */
async function safeLoadCharacter(path: string): Promise<Character> {
  try {
    const character = await loadCharacter(path);
    logger.info(`Successfully loaded character from: ${path}`);
    return character;
  } catch (e) {
    return handleCharacterLoadError(path, e);
  }
}

/**
 * Asynchronously loads a character from the specified path.
 * If the path is a URL, it loads the character from the URL.
 * If the path is a local file path, it tries multiple possible locations and
 * loads the character from the first valid location found.
 *
 * @param {string} characterPath - The path to load the character from.
 * @returns {Promise<Character>} A Promise that resolves to the loaded character.
 */
export async function loadCharacterTryPath(characterPath: string): Promise<Character> {
  if (characterPath.startsWith('http')) {
    const characters = await loadCharactersFromUrl(characterPath);
    return characters[0];
  }

  const pathsToTry = [
    characterPath,
    path.resolve(process.cwd(), '..', '..', characterPath),
    path.resolve(process.cwd(), characterPath),
    path.resolve(process.cwd(), 'agent', characterPath),
    path.resolve(__dirname, characterPath),
    path.resolve(__dirname, 'characters', path.basename(characterPath)),
    path.resolve(__dirname, '../characters', path.basename(characterPath)),
    path.resolve(__dirname, '../../characters', path.basename(characterPath)),
  ];

  for (const tryPath of pathsToTry) {
    const content = tryLoadFile(tryPath);
    if (content !== null) {
      return safeLoadCharacter(tryPath);
    }
  }

  return handleCharacterLoadError(characterPath, 'File not found in any of the expected locations');
}

/**
 * Converts a comma-separated string to an array of strings.
 *
 * @param {string} commaSeparated - The input comma-separated string.
 * @returns {string[]} An array of strings after splitting the input string by commas and trimming each value.
 */
function commaSeparatedStringToArray(commaSeparated: string): string[] {
  return commaSeparated?.split(',').map((value) => value.trim());
}

/**
 * Asynchronously reads character files from the storage directory and pushes their paths to the characterPaths array.
 * @param {string[]} characterPaths - An array of paths where the character files will be stored.
 * @returns {Promise<string[]>} - A promise that resolves with an updated array of characterPaths.
 */
async function readCharactersFromStorage(characterPaths: string[]): Promise<string[]> {
  try {
    const uploadDir = path.join(process.cwd(), 'data', 'characters');
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
  process.env.REMOTE_CHARACTER_URLS !== '' &&
  process.env.REMOTE_CHARACTER_URLS.startsWith('http');

/**
 * Load characters from local paths or remote URLs based on configuration.
 * @param charactersArg - A comma-separated list of local file paths or remote URLs to load characters from.
 * @returns A promise that resolves to an array of loaded characters.
 */
export async function loadCharacters(charactersArg: string): Promise<Character[]> {
  let characterPaths = commaSeparatedStringToArray(charactersArg);
  const loadedCharacters: Character[] = [];

  if (process.env.USE_CHARACTER_STORAGE === 'true') {
    characterPaths = await readCharactersFromStorage(characterPaths);
  }

  if (characterPaths?.length > 0) {
    for (const characterPath of characterPaths) {
      const character = await loadCharacterTryPath(characterPath);
      loadedCharacters.push(character);
    }
  }

  if (hasValidRemoteUrls()) {
    logger.info('Loading characters from remote URLs');
    const characterUrls = commaSeparatedStringToArray(process.env.REMOTE_CHARACTER_URLS);
    for (const characterUrl of characterUrls) {
      const characters = await loadCharactersFromUrl(characterUrl);
      loadedCharacters.push(...characters);
    }
  }

  if (loadedCharacters.length === 0) {
    logger.info('No characters found, using default character');
    loadedCharacters.push(defaultCharacter);
  }

  return loadedCharacters;
}

/**
 * Configuration for multer disk storage.
 *
 * @type {multer.diskStorage}
 * @property {Function} destination - Callback function to determine the destination directory for file uploads
 * @property {Function} filename - Callback function to generate a unique filename for uploaded files
 */
export const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadDir = path.join(process.cwd(), 'data', 'uploads');
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

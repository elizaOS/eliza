import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Character, logger } from '@elizaos/core';
import { getElizaCharacter } from '../characters/eliza';

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
    return readFileSync(filePath, 'utf8');
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

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

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
    const errorMsg = e instanceof Error ? e.message : String(e);
    logger.error(`Error loading character(s) from ${url}: ${errorMsg}`);

    // Instead of process.exit(1), throw a descriptive error that can be caught by our handlers
    if (errorMsg.includes('JSON')) {
      throw new Error(
        `Invalid JSON response from URL '${url}'. The resource may not contain valid character data.`
      );
    } else if (e instanceof TypeError) {
      throw new Error(
        `Failed to fetch character from URL '${url}'. The URL may be incorrect or unavailable.`
      );
    } else {
      throw new Error(`Failed to load character from URL '${url}': ${errorMsg}`);
    }
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
  const errorMsg = error instanceof Error ? error.message : String(error);

  // Check if it's a file not found error or JSON parsing error
  if (errorMsg.includes('ENOENT') || errorMsg.includes('no such file')) {
    logger.error(`Character file not found: ${path}`);
    throw new Error(
      `Character '${path}' not found. Please check if the file exists and the path is correct.`
    );
  } else if (errorMsg.includes('JSON')) {
    logger.error(`Invalid character file format: ${path}`);
    throw new Error(
      `Character file '${path}' has invalid JSON format. Please check the file content.`
    );
  } else {
    logger.error(`Error loading character from ${path}: ${errorMsg}`);
    throw new Error(`Failed to load character '${path}': ${errorMsg}`);
  }
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
    try {
      const characters = await loadCharactersFromUrl(characterPath);
      if (!characters || characters.length === 0) {
        throw new Error('No characters found in the URL response');
      }
      return characters[0];
    } catch (error) {
      // The error is already formatted by loadCharactersFromUrl, so just re-throw it
      throw error;
    }
  }

  // Create path variants with and without .json extension
  const hasJsonExtension = characterPath.toLowerCase().endsWith('.json');
  const basePath = hasJsonExtension ? characterPath : characterPath;
  const jsonPath = hasJsonExtension ? characterPath : `${characterPath}.json`;

  const basePathsToTry = [
    basePath,
    path.resolve(process.cwd(), basePath),
    path.resolve(process.cwd(), '..', '..', basePath),
    path.resolve(process.cwd(), '..', '..', '..', basePath),
    path.resolve(process.cwd(), 'agent', basePath),
    path.resolve(__dirname, basePath),
    path.resolve(__dirname, 'characters', path.basename(basePath)),
    path.resolve(__dirname, '../characters', path.basename(basePath)),
    path.resolve(__dirname, '../../characters', path.basename(basePath)),
    path.resolve(__dirname, '../../../characters', path.basename(basePath)),
  ];

  const jsonPathsToTry = hasJsonExtension
    ? []
    : [
        jsonPath,
        path.resolve(process.cwd(), jsonPath),
        path.resolve(process.cwd(), '..', '..', jsonPath),
        path.resolve(process.cwd(), '..', '..', '..', jsonPath),
        path.resolve(process.cwd(), 'agent', jsonPath),
        path.resolve(__dirname, jsonPath),
        path.resolve(__dirname, 'characters', path.basename(jsonPath)),
        path.resolve(__dirname, '../characters', path.basename(jsonPath)),
        path.resolve(__dirname, '../../characters', path.basename(jsonPath)),
        path.resolve(__dirname, '../../../characters', path.basename(jsonPath)),
      ];

  // Combine the paths to try both variants
  const pathsToTry = Array.from(new Set([...basePathsToTry, ...jsonPathsToTry]));

  let lastError = null;

  for (const tryPath of pathsToTry) {
    try {
      const content = tryLoadFile(tryPath);
      if (content !== null) {
        return safeLoadCharacter(tryPath);
      }
    } catch (e) {
      lastError = e;
      // Continue trying other paths
    }
  }

  // If we get here, all paths failed
  const errorMessage = lastError
    ? `${lastError}`
    : 'File not found in any of the expected locations';
  return handleCharacterLoadError(
    characterPath,
    `Character not found. Tried ${pathsToTry.length} locations. ${errorMessage}`
  );
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
    const uploadDir = path.join(process.cwd(), '.eliza', 'data', 'characters');
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
    const characterUrls = commaSeparatedStringToArray(process.env.REMOTE_CHARACTER_URLS || '');
    for (const characterUrl of characterUrls) {
      const characters = await loadCharactersFromUrl(characterUrl);
      loadedCharacters.push(...characters);
    }
  }

  if (loadedCharacters.length === 0) {
    logger.info('No characters found, using default character');
    loadedCharacters.push(getElizaCharacter());
  }

  return loadedCharacters;
}

import { type Character, logger } from '@elizaos/core';

// Import the server module instead of individual exports
import * as serverLoader from '@elizaos/server';
import { character as defaultCharacter } from '../../../characters/eliza';

/**
 * Attempts to load a file from the given file path.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} filePath - The path to the file to load.
 * @returns {string | null} The contents of the file as a string, or null if an error occurs.
 */
export function tryLoadFile(filePath: string): string | null {
  return (serverLoader as any).tryLoadFile?.(filePath) ?? null;
}

/**
 * Loads character data from the provided URL.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} url - The URL to load character data from.
 * @returns {Promise<Character[]>} A promise that resolves to an array of Character objects.
 */
export async function loadCharactersFromUrl(url: string): Promise<Character[]> {
  if ((serverLoader as any).loadCharactersFromUrl) {
    return await (serverLoader as any).loadCharactersFromUrl(url);
  }
  return [];
}

/**
 * Converts a JSON object to a Character object.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {any} obj - The JSON object to convert.
 * @returns {Promise<Character>} A promise that resolves to a Character object.
 */
export async function jsonToCharacter(obj: any): Promise<Character> {
  if ((serverLoader as any).jsonToCharacter) {
    return await (serverLoader as any).jsonToCharacter(obj);
  }
  return obj as Character;
}

/**
 * Loads a character from the specified file path.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} filePath - The path to the character file.
 * @returns {Promise<Character>} A promise that resolves to the loaded Character object.
 * @throws {Error} If the character file cannot be loaded or parsed.
 */
export async function loadCharacter(filePath: string): Promise<Character> {
  if ((serverLoader as any).loadCharacter) {
    return await (serverLoader as any).loadCharacter(filePath);
  }
  throw new Error('loadCharacter not available in server module');
}

/**
 * Tries to load a character from the given path.
 * If the path is a URL, it loads from the URL.
 * If the path is a local file path, it loads from the file.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} characterPath - The path or URL to the character file.
 * @returns {Promise<Character>} A promise that resolves to the loaded Character object.
 */
export async function loadCharacterTryPath(characterPath: string): Promise<Character> {
  if ((serverLoader as any).loadCharacterTryPath) {
    const result = await (serverLoader as any).loadCharacterTryPath(characterPath);
    if (result) return result;
  }

  // Fallback to default character if loader fails
  logger.warn(`Failed to load character from ${characterPath}, using default character`);
  return defaultCharacter;
}

/**
 * Checks if environment variables contain valid remote URLs for character loading.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @returns {boolean} True if valid remote URLs exist, false otherwise.
 */
export function hasValidRemoteUrls(): boolean {
  if ((serverLoader as any).hasValidRemoteUrls) {
    return (serverLoader as any).hasValidRemoteUrls();
  }
  return false;
}

/**
 * Loads characters from the provided argument string.
 * Supports multiple formats: single file, comma-separated files, directory, or remote URLs.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} charactersArg - The characters argument string.
 * @returns {Promise<Character[]>} A promise that resolves to an array of loaded Character objects.
 */
export async function loadCharacters(charactersArg: string): Promise<Character[]> {
  if ((serverLoader as any).loadCharacters) {
    return await (serverLoader as any).loadCharacters(charactersArg);
  }
  return [];
}
import { type Character, logger } from '@elizaos/core';
import { loadModule, loadModuleSync } from '@/src/utils/module-loader';
import { character as defaultCharacter } from '../../../characters/eliza';

/**
 * Attempts to load a file from the given file path.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} filePath - The path to the file to load.
 * @returns {string | null} The contents of the file as a string, or null if an error occurred.
 * @throws {Error} If an error occurs while loading the file.
 */
export function tryLoadFile(filePath: string): string | null {
  // Use synchronous module loading to maintain backward compatibility
  const serverModule = loadModuleSync('@elizaos/server');
  return serverModule.tryLoadFile(filePath);
}

/**
 * Attempts to load a file from the given file path asynchronously.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} filePath - The path to the file to load.
 * @returns {Promise<string | null>} The contents of the file as a string, or null if an error occurred.
 * @throws {Error} If an error occurs while loading the file.
 */
export async function tryLoadFileAsync(filePath: string): Promise<string | null> {
  // Since this is a deprecated function delegating to server,
  // we need to load the server module asynchronously
  const serverModule = await loadModule('@elizaos/server');
  return serverModule.tryLoadFile(filePath);
}

/**
 * Load characters from a specified URL and return them as an array of Character objects.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} url - The URL from which to load character data.
 * @returns {Promise<Character[]>} - A promise that resolves with an array of Character objects.
 */
export async function loadCharactersFromUrl(url: string): Promise<Character[]> {
  const serverModule = await loadModule('@elizaos/server');
  return serverModule.loadCharactersFromUrl(url);
}

/**
 * Converts a JSON object representing a character into a validated Character object with additional settings and secrets.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {unknown} character - The input data representing a character.
 * @returns {Promise<Character>} - A Promise that resolves to a validated Character object.
 * @throws {Error} If character validation fails.
 */
export async function jsonToCharacter(character: unknown): Promise<Character> {
  const serverModule = await loadModule('@elizaos/server');
  return serverModule.jsonToCharacter(character);
}

/**
 * Loads a character from the specified file path with safe JSON parsing and validation.
 *
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @param {string} filePath - The path to the character file.
 * @returns {Promise<Character>} A Promise that resolves to the validated Character object.
 * @throws {Error} If the character file is not found, has invalid JSON, or fails validation.
 */
export async function loadCharacter(filePath: string): Promise<Character> {
  const serverModule = await loadModule('@elizaos/server');
  return serverModule.loadCharacter(filePath);
}

/**
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 */
export async function loadCharacterTryPath(characterPath: string): Promise<Character> {
  const serverModule = await loadModule('@elizaos/server');
  return serverModule.loadCharacterTryPath(characterPath);
}

/**
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @returns {boolean} true if valid remote URLs exist, false otherwise.
 */
export function hasValidRemoteUrls(): boolean {
  // Use synchronous module loading to maintain backward compatibility
  const serverModule = loadModuleSync('@elizaos/server');
  return serverModule.hasValidRemoteUrls();
}

/**
 * @deprecated Use @elizaos/server implementation. This function delegates to server.
 * @returns {Promise<boolean>} A promise that resolves to true if valid remote URLs exist, false otherwise.
 */
export async function hasValidRemoteUrlsAsync(): Promise<boolean> {
  // Since this is a deprecated function delegating to server,
  // we need to load the server module asynchronously
  const serverModule = await loadModule('@elizaos/server');
  return serverModule.hasValidRemoteUrls();
}

/**
 * Load characters from local paths or remote URLs based on configuration.
 * CLI-specific version that falls back to default character when no characters are found.
 *
 * @param charactersArg - A comma-separated list of local file paths or remote URLs to load characters from.
 * @returns A promise that resolves to an array of loaded characters.
 */
export async function loadCharacters(charactersArg: string): Promise<Character[]> {
  const serverModule = await loadModule('@elizaos/server');
  // Delegate to server implementation for main loading logic
  const loadedCharacters = await serverModule.loadCharacters(charactersArg);

  // CLI-specific behavior: fallback to default character if no characters found
  if (loadedCharacters.length === 0) {
    logger.info('No characters found, using default character');
    return [defaultCharacter];
  }

  return loadedCharacters;
}

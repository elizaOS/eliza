import { logger, type Character } from '@elizaos/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveCharacterPath, loadCharacterQuietly } from '@/src/utils/character-finder';

/**
 * Represents a character file that can be updated
 */
export interface CharacterFile {
  path: string;
  format: 'json' | 'typescript';
  character: Character;
  content?: string;
}

/**
 * Load a character file and determine its format
 */
export async function loadCharacterFile(characterPath: string): Promise<CharacterFile> {
  const resolvedPath = resolveCharacterPath(characterPath);
  
  if (!resolvedPath) {
    throw new Error(`Character file not found: ${characterPath}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  
  if (ext === '.json') {
    const character = await loadCharacterQuietly(resolvedPath);
    if (!character) {
      throw new Error(`Failed to load character from: ${resolvedPath}`);
    }
    return {
      path: resolvedPath,
      format: 'json',
      character,
      content: fs.readFileSync(resolvedPath, 'utf-8')
    };
  } else if (ext === '.ts' || ext === '.js') {
    // For TypeScript/JavaScript files, we need special handling
    // This is a limitation - we can't easily load TS files without compilation
    throw new Error(`TypeScript/JavaScript character files are not yet supported for plugin updates`);
  } else {
    throw new Error(`Unsupported character file format: ${ext}`);
  }
}

/**
 * Add a plugin to a character's plugins array
 */
export function addPluginToCharacter(character: Character, pluginName: string): Character {
  const plugins = character.plugins || [];
  
  // Check if plugin already exists
  if (plugins.includes(pluginName)) {
    logger.info(`Plugin '${pluginName}' is already in character '${character.name}'`);
    return character;
  }
  
  return {
    ...character,
    plugins: [...plugins, pluginName]
  };
}

/**
 * Remove a plugin from a character's plugins array
 */
export function removePluginFromCharacter(character: Character, pluginName: string): Character {
  const plugins = character.plugins || [];
  
  // Check if plugin exists
  if (!plugins.includes(pluginName)) {
    logger.info(`Plugin '${pluginName}' is not in character '${character.name}'`);
    return character;
  }
  
  return {
    ...character,
    plugins: plugins.filter(p => p !== pluginName)
  };
}

/**
 * Update a JSON character file
 */
export async function updateJsonCharacterFile(
  filePath: string, 
  character: Character
): Promise<void> {
  const content = JSON.stringify(character, null, 2);
  fs.writeFileSync(filePath, content, 'utf-8');
  logger.info(`Updated character file: ${filePath}`);
}

/**
 * Update a character file with a plugin change
 */
export async function updateCharacterFile(
  characterFile: CharacterFile,
  pluginName: string,
  operation: 'add' | 'remove'
): Promise<void> {
  const updatedCharacter = operation === 'add' 
    ? addPluginToCharacter(characterFile.character, pluginName)
    : removePluginFromCharacter(characterFile.character, pluginName);

  if (characterFile.format === 'json') {
    await updateJsonCharacterFile(characterFile.path, updatedCharacter);
  } else {
    throw new Error('TypeScript character file updates are not yet supported');
  }
}

/**
 * Resolve character paths from various input formats
 * Re-export from character-parser for backward compatibility
 */
export { parseCharacterPaths as resolveCharacterPaths } from '@/src/utils/character-parser'; 
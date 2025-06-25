import { logHeader } from '@/src/utils';
import { detectDirectoryType } from '@/src/utils/directory-detection';
import { parseCharacterPaths } from '@/src/utils/character-parser';
import { 
  isValidCharacterFile,
  findCharactersFromPaths,
  findAllCharacterFiles,
  loadCharacterQuietly
} from '@/src/utils/character-finder';
import { logger } from '@elizaos/core';

/**
 * List installed plugins mapped to characters in the current project
 */
export async function showInstalledPlugins(characterPaths?: string[]): Promise<void> {
  const cwd = process.cwd();
  const directoryInfo = detectDirectoryType(cwd);

  if (!directoryInfo || !directoryInfo.hasPackageJson) {
    console.error(
      `Could not read or parse package.json. This directory is: ${directoryInfo?.type || 'invalid or inaccessible'}`
    );
    console.info('Please run this command from the root of an ElizaOS project.');
    process.exit(1);
  }

  // Parse character paths (handles comma-separated values)
  const parsedPaths = parseCharacterPaths(characterPaths);

  // If specific characters are provided, show only those characters' plugins
  if (parsedPaths.length > 0) {
    // First find and validate the character files
    const characterFilePaths = await findCharactersFromPaths(parsedPaths);
    
    if (characterFilePaths.size === 0) {
      console.log('No valid character files found for the specified paths.');
      console.log('Please check your character paths and try again.');
      return;
    }

    // Then load the characters and get their plugins
    const characterPluginMap = new Map<string, string[]>();
    
    for (const [name, filePath] of characterFilePaths) {
      try {
        const character = await loadCharacterQuietly(filePath);
        const characterName = character.name || name;
        const plugins = character.plugins || [];
        characterPluginMap.set(characterName, plugins);
      } catch (error) {
        logger.error(`Failed to load character from ${filePath}: ${error}`);
      }
    }
    
    // Display character plugin mapping
    logHeader('Character Plugin Mapping:');
    for (const [characterName, plugins] of characterPluginMap) {
      console.log(`\n${characterName}:`);
      if (plugins.length === 0) {
        console.log('  (no plugins)');
      } else {
        plugins.forEach((plugin: string) => console.log(`  - ${plugin}`));
      }
    }
    
    return;
  }

  // If no specific characters provided, scan all character files in the project
  const allCharacterFiles = findAllCharacterFiles(cwd);
  
  // Try to load each file and collect plugin information
  const characterPluginMap = new Map<string, string[]>();
  
  for (const filePath of allCharacterFiles) {
    try {
      // Check if it's a valid character file
      const isValid = await isValidCharacterFile(filePath);
      if (!isValid) {
        continue;
      }
      
      // It's a valid character file, try to load it
      const character = await loadCharacterQuietly(filePath);
      const characterName = character.name;
      const plugins = character.plugins || [];
      characterPluginMap.set(characterName, plugins);
    } catch (error) {
      // Skip files that can't be loaded
    }
  }

  if (characterPluginMap.size === 0) {
    console.log('No character files found in the project.');
    return;
  }

  // Display character plugin mapping
  for (const [characterName, plugins] of characterPluginMap) {
    logHeader(`Plugins for ${characterName}:`);
    if (plugins.length === 0) {
      console.log('  (no plugins)');
    } else {
      plugins.forEach(plugin => console.log(`  - ${plugin}`));
    }
    console.log();
  }
} 
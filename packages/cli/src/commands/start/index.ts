import { displayBanner, handleError } from '@/src/utils';
import { validatePort } from '@/src/utils/port-validation';
import { parseCharacterPaths } from '@/src/utils/character-parser';
import { resolveCharacterPath, loadCharacterQuietly, findAllCharacterFiles, getCharacterInfo } from '@/src/utils/character-finder';
import { loadProject } from '@/src/project';
import { logger, type Character, type ProjectAgent } from '@elizaos/core';
import { Command } from 'commander';
import { startAgents } from './actions/server-start';
import { StartOptions } from './types';
import * as path from 'node:path';
import { loadEnvConfig } from './utils/config-utils';
import { detectDirectoryType } from '@/src/utils/directory-detection';

export const start = new Command()
  .name('start')
  .description('Start the Eliza agent server')
  .option('-c, --configure', 'Reconfigure services and AI models')
  .option('-p, --port <port>', 'Port to listen on', validatePort)
  .option('--character <paths...>', 'Character file(s) to use')
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (options: StartOptions & { character?: string[] }) => {
    try {
      // Load env config first before any character loading
      await loadEnvConfig();

      let characters: Character[] = [];
      let projectAgents: ProjectAgent[] = [];

      if (options.character && options.character.length > 0) {
        // Parse character paths (handles comma-separated values, quotes, etc.)
        const characterPaths = parseCharacterPaths(options.character);
        
        // Validate and load characters from provided paths
        for (const charPath of characterPaths) {
          const resolvedPath = resolveCharacterPath(charPath);

          if (!resolvedPath) {
            logger.error(`Character file not found: ${charPath}`);
            throw new Error(`Character file not found: ${charPath}`);
          }

          try {
            const character = await loadCharacterQuietly(resolvedPath);
            if (character) {
              characters.push(character);
              logger.info(`Successfully loaded character: ${character.name}`);
            } else {
              logger.error(
                `Failed to load character from ${resolvedPath}: Invalid or empty character file`
              );
              throw new Error(`Invalid character file: ${resolvedPath}`);
            }
          } catch (e) {
            logger.error(`Failed to load character from ${resolvedPath}:`, e);
            throw new Error(`Invalid character file: ${resolvedPath}`);
          }
        }
      } else {
        // Try to load project agents if no character files specified
        const cwd = process.cwd();
        const dirInfo = detectDirectoryType(cwd);

        // First, list available characters
        logger.info('No character files specified. Searching for available characters...');
        
        const allCharacterFiles = await findAllCharacterFiles(cwd);
        const validCharacters: Array<{ name: string; path: string }> = [];
        
        for (const file of allCharacterFiles) {
          const characterInfo = await getCharacterInfo(file);
          if (characterInfo) {
            const relativePath = path.relative(cwd, characterInfo.path);
            validCharacters.push({
              name: characterInfo.name,
              path: relativePath
            });
          }
        }
        
        if (validCharacters.length > 0) {
          logger.info(`Found ${validCharacters.length} character file(s) in project:`);
          for (const char of validCharacters) {
            logger.info(`  - ${char.name} (${char.path})`);
          }
          logger.info('\nTo use a specific character, run:');
          logger.info('  elizaos start --character <character-name>');
        }

        // Try to load project agents
        let projectLoaded = false;
        try {
          // Check if we're in a directory that might contain agents - allow any directory with package.json
          // except those explicitly detected as non-ElizaOS (covers projects, plugins, monorepos, etc.)
          if (dirInfo.hasPackageJson && dirInfo.type !== 'non-elizaos-dir') {
            logger.debug('Checking for project configuration...');
            const project = await loadProject(cwd);

            if (project.agents && project.agents.length > 0) {
              projectAgents = project.agents;
              projectLoaded = true;

              // Log what we're using
              if (project.isPlugin) {
                logger.info(`\nRunning in plugin test mode with default Eliza character.`);
                logger.info(`Testing plugin: ${project.pluginModule?.name || 'unknown'}`);
              } else {
                logger.info(`\nRunning ${project.agents.length} agent(s) from project configuration:`);
                for (const agent of project.agents) {
                  if (agent.character) {
                    logger.info(`  - ${agent.character.name}`);
                  }
                }
              }
            }
          }
        } catch (e: any) {
          // Only log the error if it's not the expected "No project configuration found" error
          if (e.message !== 'No project configuration found') {
            logger.debug('Error loading project:', e.message);
          }
          // This is expected when there's no project configuration
          // Don't log anything - we'll inform the user below
        }

        // If no project was loaded, inform the user we're using defaults
        if (!projectLoaded && validCharacters.length === 0) {
          logger.info('\nNo project configuration or character files found.');
          logger.info('Running with default Eliza character.');
          logger.info('\nTo create a project with characters, run: elizaos create --type project');
        } else if (!projectLoaded && validCharacters.length > 0) {
          logger.info('\nNo project configuration found.');
          logger.info('To use one of the characters above, run with --character flag');
        }
      }

      await startAgents({ ...options, characters, projectAgents });
    } catch (e: any) {
      handleError(e);
      process.exit(1);
    }
  });

// Re-export for backward compatibility
export * from './actions/agent-start';
export * from './actions/server-start';
export * from './types';
export * from './utils/config-utils';
export * from './utils/dependency-resolver';
export * from './utils/plugin-utils';

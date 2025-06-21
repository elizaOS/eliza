import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { logger } from '@elizaos/core';

export interface ProjectConfig {
  character?: any;
  plugins?: string[];
}

/**
 * Load project configuration from the project directory
 */
export async function loadProjectConfig(projectPath: string): Promise<ProjectConfig> {
  const config: ProjectConfig = {};

  // Check for character file
  const characterFiles = ['character.json', 'agent.json', 'character.js', 'character.ts'];

  for (const file of characterFiles) {
    const filePath = path.join(projectPath, file);
    if (existsSync(filePath)) {
      try {
        if (file.endsWith('.json')) {
          const content = await readFile(filePath, 'utf-8');
          config.character = JSON.parse(content);
        } else {
          // For JS/TS files, we'd need to import them
          // For now, skip these
          logger.warn(`Found ${file} but JS/TS character files are not yet supported in test mode`);
        }
        break;
      } catch (error) {
        logger.error(`Error loading character from ${file}:`, error);
      }
    }
  }

  // Check for package.json to get plugin dependencies
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const content = await readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);

      // Look for elizaos plugins in dependencies
      if (packageJson.dependencies) {
        config.plugins = Object.keys(packageJson.dependencies).filter((dep) =>
          dep.startsWith('@elizaos/plugin-')
        );
      }
    } catch (error) {
      logger.error('Error loading package.json:', error);
    }
  }

  return config;
}

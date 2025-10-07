import { detectDirectoryType } from '@/src/utils/directory-detection';
import { logger } from '@elizaos/core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Dependencies } from '../types';

/**
 * Helper function to get dependencies from package.json using directory detection
 */
export const getDependenciesFromDirectory = (cwd: string): Dependencies | null => {
  const directoryInfo = detectDirectoryType(cwd);

  if (!directoryInfo.hasPackageJson) {
    return null;
  }

  try {
    const packageJsonPath = path.join(cwd, 'package.json');
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};
    return { ...dependencies, ...devDependencies };
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn(`Could not parse package.json: ${error.message}`);
    } else {
      logger.warn(
        `Error reading package.json: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  }
};

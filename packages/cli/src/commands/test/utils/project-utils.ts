import { detectDirectoryType, type DirectoryInfo } from '@/src/utils/directory-detection';
import { loadProject } from '@/src/project';
import { runBunCommand } from '@/src/utils/run-bun';
import { logger } from '@elizaos/core';
import * as fs from 'node:fs';
import path from 'node:path';

/**
 * Determines the project type using comprehensive directory detection
 */
export function getProjectType(testPath?: string): DirectoryInfo {
  const targetPath = testPath ? path.resolve(process.cwd(), testPath) : process.cwd();
  return detectDirectoryType(targetPath);
}

// Note: findMonorepoRoot() has been removed - use UserEnvironment.getInstance().findMonorepoRoot() instead
// This centralized version looks for packages/core directory instead of lerna.json for better reliability

/**
 * Process filter name to remove extensions consistently
 *
 * Note: Test filtering works in two ways:
 * 1. Matching test suite names (the string in describe() blocks)
 * 2. Matching file names (without extension)
 *
 * For best results, use the specific test suite name you want to run.
 * The filter is applied case-insensitively for better user experience.
 */
export function processFilterName(name?: string): string | undefined {
  if (!name) return undefined;

  // Handle common filter formats (case-insensitive)
  let baseName = name.toLowerCase();

  if (
    baseName.endsWith('.test.ts') ||
    baseName.endsWith('.test.js') ||
    baseName.endsWith('.spec.ts') ||
    baseName.endsWith('.spec.js')
  ) {
    baseName = baseName.slice(0, -8); // Remove '.test.ts' / '.test.js' / '.spec.ts' / '.spec.js'
  } else if (baseName.endsWith('.test') || baseName.endsWith('.spec')) {
    baseName = baseName.slice(0, -5); // Remove '.test' / '.spec'
  }

  return baseName;
}

/**
 * Install plugin dependencies for testing
 */
export async function installPluginDependencies(projectInfo: DirectoryInfo): Promise<void> {
  if (projectInfo.type !== 'elizaos-plugin') {
    return;
  }

  const project = await loadProject(process.cwd());
  if (
    project.isPlugin &&
    project.pluginModule?.dependencies &&
    project.pluginModule.dependencies.length > 0
  ) {
    const pluginsDir = path.join(process.cwd(), '.eliza', 'plugins');
    if (!fs.existsSync(pluginsDir)) {
      await fs.promises.mkdir(pluginsDir, { recursive: true });
    }

    const packageJsonPath = path.join(pluginsDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      const packageJsonContent = {
        name: 'test-plugin-dependencies',
        version: '1.0.0',
        description: 'A temporary package for installing test plugin dependencies',
        dependencies: {},
      };
      await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJsonContent, null, 2));
    }

    const { installPlugin } = await import('@/src/utils');

    for (const dependency of project.pluginModule.dependencies) {
      await installPlugin(dependency, pluginsDir);
      const dependencyPath = path.join(pluginsDir, 'node_modules', dependency);
      if (fs.existsSync(dependencyPath)) {
        try {
          await runBunCommand(['install'], dependencyPath);
        } catch (error) {
          logger.warn(
            `[Test Command] Failed to install devDependencies for ${dependency}: ${error}`
          );
        }
      }
    }
  }
}

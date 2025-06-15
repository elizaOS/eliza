import { buildProject, UserEnvironment } from '@/src/utils';
import { detectDirectoryType } from '@/src/utils/directory-detection';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BuildResult, DevContext } from '../types';

/**
 * Build a single package
 */
async function buildPackage(packagePath: string, isPlugin: boolean): Promise<BuildResult> {
  const startTime = Date.now();

  try {
    await buildProject(packagePath, isPlugin);
    const duration = Date.now() - startTime;
    return { success: true, duration };
  } catch (error) {
    const duration = Date.now() - startTime;
    return { success: false, duration, error: error as Error };
  }
}

/**
 * Build core packages in a monorepo
 */
async function buildCorePackages(monorepoRoot: string): Promise<BuildResult[]> {
  const corePackages = [
    {
      name: 'core',
      path: path.join(monorepoRoot, 'packages', 'core'),
      isPlugin: false,
    },
    {
      name: 'client',
      path: path.join(monorepoRoot, 'packages', 'client'),
      isPlugin: false,
    },
    {
      name: 'plugin-bootstrap',
      path: path.join(monorepoRoot, 'packages', 'plugin-bootstrap'),
      isPlugin: true,
    },
  ];

  const results: BuildResult[] = [];

  for (const pkg of corePackages) {
    console.info(`Building ${pkg.name}...`);
    const result = await buildPackage(pkg.path, pkg.isPlugin);

    if (!result.success) {
      console.error(`Error building ${pkg.name}: ${result.error?.message}`);
    } else {
      console.info(`✓ Built ${pkg.name} (${result.duration}ms)`);
    }

    results.push(result);
  }

  return results;
}

/**
 * Perform a full rebuild based on the development context
 *
 * Handles building in different contexts: monorepo, project, or plugin.
 */
export async function performRebuild(context: DevContext): Promise<void> {
  console.info('Rebuilding...');

  const { directory, directoryType } = context;
  const isPlugin = directoryType.type === 'elizaos-plugin';
  const isMonorepo = directoryType.type === 'elizaos-monorepo';

  if (isMonorepo || directoryType.monorepoRoot) {
    const { monorepoRoot } = await UserEnvironment.getInstance().getPathInfo();
    if (monorepoRoot) {
      await buildCorePackages(monorepoRoot);
    } else {
      console.warn('Monorepo context detected, but failed to find monorepo root.');
    }
  }

  // Build the current project/plugin
  const result = await buildPackage(directory, isPlugin);

  if (result.success) {
    console.log(`✓ Rebuild successful (${result.duration}ms)`);
  } else {
    console.error(`Build failed: ${result.error?.message}`);
    throw result.error;
  }
}

/**
 * Perform initial build setup
 */
export async function performInitialBuild(context: DevContext): Promise<void> {
  const { directoryType, directory } = context;
  const isPlugin = directoryType.type === 'elizaos-plugin';
  const isMonorepo = directoryType.type === 'elizaos-monorepo';

  if (process.env.ELIZA_TEST_MODE) {
    console.info('Skipping initial build in test mode');
    return;
  }

  // Ensure initial build is performed (skip for monorepo as it may have multiple projects)
  if (!isMonorepo) {
    console.info('Building project...');
    try {
      await buildProject(directory, isPlugin);
      console.info('✓ Initial build completed');
    } catch (error) {
      console.error(
        `Initial build failed: ${error instanceof Error ? error.message : String(error)}`
      );
      console.info('Continuing with dev mode anyway...');
    }
  } else {
    console.info(
      'Monorepo detected - skipping automatic build. Use specific package build commands as needed.'
    );
  }
}

/**
 * Create development context from current working directory
 */
export function createDevContext(cwd: string): DevContext {
  const directoryType = detectDirectoryType(cwd);

  if (!directoryType) {
    throw new Error(
      'Cannot start development mode in this directory. Directory is not accessible or does not exist.'
    );
  }

  const srcDir = path.join(cwd, 'src');

  return {
    directory: cwd,
    directoryType,
    watchDirectory: existsSync(srcDir) ? srcDir : cwd,
    buildRequired: directoryType.type !== 'elizaos-monorepo',
  };
}

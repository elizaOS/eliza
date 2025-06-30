import { getElizaCharacter } from '@/src/characters/eliza';
import { copyTemplate as copyTemplateUtil, buildProject } from '@/src/utils';
import { join } from 'path';
import fs from 'node:fs/promises';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import { processPluginName, validateTargetDirectory } from '../utils';
import { installDependencies, setupProjectEnvironment } from './setup';
import { existsSync, rmSync } from 'node:fs';
import { getDisplayDirectory } from '@/src/utils/helpers';

/**
 * wraps the creation process with cleanup handlers that remove the directory
 * if the user interrupts with ctrl-c during installation
 */
async function withCleanupOnInterrupt<T>(
  targetDir: string,
  displayName: string,
  fn: () => Promise<T>
): Promise<T> {
  const cleanup = () => {
    // only clean up if directory actually exists
    if (existsSync(targetDir)) {
      console.info(colors.red(`\n\nInterrupted! Cleaning up ${displayName}...`));
      try {
        rmSync(targetDir, { recursive: true, force: true });
        console.info('Cleanup completed.');
      } catch (error) {
        console.error(colors.red('Error during cleanup:'), error);
      }
    }
  };

  // store handler references for proper cleanup
  const sigintHandler = () => {
    cleanup();
    process.exit(130);
  };
  const sigtermHandler = () => {
    cleanup();
    process.exit(143);
  };

  // register cleanup on all the ways a process can die
  // SIGINT (130) is ctrl-c, SIGTERM (143) is kill command
  process.on('exit', cleanup);
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  try {
    const result = await fn();
    
    // success - remove only our cleanup handlers
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    
    return result;
  } catch (error) {
    // remove only our cleanup handlers
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    
    // cleanup on error
    if (existsSync(targetDir)) {
      try {
        console.info(colors.red(`\nCleaning up due to error...`));
        rmSync(targetDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // ignore cleanup errors
      }
    }
    throw error;
  }
}

/**
 * Creates a new plugin with the specified name and configuration.
 */
export async function createPlugin(
  pluginName: string,
  targetDir: string,
  isNonInteractive = false
): Promise<void> {
  // Process and validate the plugin name
  const nameResult = processPluginName(pluginName);
  if (!nameResult.isValid) {
    throw new Error(nameResult.error || 'Invalid plugin name');
  }

  const processedName = nameResult.processedName!;
  // Add prefix to ensure plugin directory name follows convention
  const pluginDirName = processedName.startsWith('plugin-')
    ? processedName
    : `plugin-${processedName}`;
  const pluginTargetDir = join(targetDir, pluginDirName);

  // Validate target directory
  const dirResult = await validateTargetDirectory(pluginTargetDir);
  if (!dirResult.isValid) {
    throw new Error(dirResult.error || 'Invalid target directory');
  }

  if (!isNonInteractive) {
    const displayDir = getDisplayDirectory(targetDir);
    const confirmCreate = await clack.confirm({
      message: `Create plugin "${pluginDirName}" in ${displayDir}?`,
    });

    if (clack.isCancel(confirmCreate) || !confirmCreate) {
      clack.cancel('Plugin creation cancelled.');
      process.exit(0);
    }
  }

  await withCleanupOnInterrupt(pluginTargetDir, pluginDirName, async () => {
    // Copy plugin template
    await copyTemplateUtil('plugin', pluginTargetDir);

    // Install dependencies
    await installDependencies(pluginTargetDir);

    console.info(`\n${colors.green('✓')} Plugin "${pluginDirName}" created successfully!`);
    console.info(`\nNext steps:`);
    console.info(`  cd ${pluginDirName}`);
    console.info(`  bun run build`);
    console.info(`  bun run test\n`);
  });
}

/**
 * Creates a new agent character file with the specified name.
 */
export async function createAgent(
  agentName: string,
  targetDir: string,
  isNonInteractive = false
): Promise<void> {
  const agentFilePath = join(targetDir, `${agentName}.json`);

  // Check if agent file already exists
  try {
    await fs.access(agentFilePath);
    throw new Error(`Agent file ${agentFilePath} already exists`);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    // File doesn't exist, which is what we want
  }

  if (!isNonInteractive) {
    const displayDir = getDisplayDirectory(targetDir);
    const confirmCreate = await clack.confirm({
      message: `Create agent "${agentName}" in ${displayDir}?`,
    });

    if (clack.isCancel(confirmCreate) || !confirmCreate) {
      clack.cancel('Agent creation cancelled.');
      process.exit(0);
    }
  }

  // Create agent character based on Eliza template
  const agentCharacter = {
    ...getElizaCharacter(),
    name: agentName,
    bio: [
      `${agentName} is a helpful AI assistant created to provide assistance and engage in meaningful conversations.`,
      `${agentName} is knowledgeable, creative, and always eager to help users with their questions and tasks.`,
    ],
  };

  await fs.writeFile(agentFilePath, JSON.stringify(agentCharacter, null, 2));

  if (!isNonInteractive) {
    console.info(`\n${colors.green('✓')} Agent "${agentName}" created successfully!`);
  }
  console.info(`Agent character created successfully at: ${agentFilePath}`);
  console.info(`\nTo use this agent:`);
  console.info(`  elizaos agent start --path ${agentFilePath}\n`);
}

/**
 * Creates a new TEE project with the specified name and configuration.
 */
export async function createTEEProject(
  projectName: string,
  targetDir: string,
  database: string,
  aiModel: string,
  embeddingModel?: string,
  isNonInteractive = false
): Promise<void> {
  const teeTargetDir = join(targetDir, projectName);

  // Validate target directory
  const dirResult = await validateTargetDirectory(teeTargetDir);
  if (!dirResult.isValid) {
    throw new Error(dirResult.error || 'Invalid target directory');
  }

  if (!isNonInteractive) {
    const displayDir = getDisplayDirectory(targetDir);
    const confirmCreate = await clack.confirm({
      message: `Create TEE project "${projectName}" in ${displayDir}?`,
    });

    if (clack.isCancel(confirmCreate) || !confirmCreate) {
      clack.cancel('TEE project creation cancelled.');
      process.exit(0);
    }
  }

  await withCleanupOnInterrupt(teeTargetDir, projectName, async () => {
    // Copy TEE template
    await copyTemplateUtil('project-tee-starter', teeTargetDir);

    // Set up project environment
    await setupProjectEnvironment(teeTargetDir, database, aiModel, embeddingModel, isNonInteractive);

    // Install dependencies
    await installDependencies(teeTargetDir);

    // Build the project
    await buildProject(teeTargetDir, false);

    console.info(`\n${colors.green('✓')} TEE project "${projectName}" created successfully!`);
    console.info(`\nNext steps:`);
    console.info(`  cd ${projectName}`);
    console.info(`  bun run dev\n`);
  });
}

/**
 * Creates a new regular project with the specified name and configuration.
 */
export async function createProject(
  projectName: string,
  targetDir: string,
  database: string,
  aiModel: string,
  embeddingModel?: string,
  isNonInteractive = false
): Promise<void> {
  // Handle current directory case
  const projectTargetDir = projectName === '.' ? targetDir : join(targetDir, projectName);

  // Validate target directory
  const dirResult = await validateTargetDirectory(projectTargetDir);
  if (!dirResult.isValid) {
    throw new Error(dirResult.error || 'Invalid target directory');
  }

  if (!isNonInteractive) {
    const displayDir = getDisplayDirectory(targetDir);
    const displayProjectName = projectName === '.' ? 'project' : `project "${projectName}"`;
    const confirmCreate = await clack.confirm({
      message: `Create ${displayProjectName} in ${displayDir}?`,
    });

    if (clack.isCancel(confirmCreate) || !confirmCreate) {
      clack.cancel('Project creation cancelled.');
      process.exit(0);
    }
  }

  // only use cleanup wrapper for new directories, not current directory
  const createFn = async () => {
    // Copy project template
    await copyTemplateUtil('project-starter', projectTargetDir);

    // Set up project environment
    await setupProjectEnvironment(
      projectTargetDir,
      database,
      aiModel,
      embeddingModel,
      isNonInteractive
    );

    // Install dependencies
    await installDependencies(projectTargetDir);

    // Build the project
    await buildProject(projectTargetDir, false);

    const displayName = projectName === '.' ? 'Project' : `Project "${projectName}"`;
    console.info(`\n${colors.green('✓')} ${displayName} initialized successfully!`);
    console.info(`\nNext steps:`);
    console.info(`  cd ${projectName}`);
    console.info(`  bun run dev\n`);
  };

  if (projectName === '.') {
    // for current directory, no cleanup needed
    await createFn();
  } else {
    // for new directory, use cleanup wrapper
    await withCleanupOnInterrupt(projectTargetDir, projectName, createFn);
  }
}

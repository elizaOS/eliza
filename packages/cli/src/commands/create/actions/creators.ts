import { getElizaCharacter } from '@/src/characters/eliza';
import { copyTemplate as copyTemplateUtil, buildProject } from '@/src/utils';
import { join } from 'path';
import fs from 'node:fs/promises';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import { processPluginName, validateTargetDirectory } from '../utils';
import { installDependencies, setupProjectEnvironment } from './setup';
import { spawn } from 'child_process';
import path from 'path';

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
    const confirmCreate = await clack.confirm({
      message: `Create plugin "${pluginDirName}" in ${pluginTargetDir}?`,
    });

    if (clack.isCancel(confirmCreate) || !confirmCreate) {
      clack.cancel('Plugin creation cancelled.');
      process.exit(0);
    }
  }

  // Copy plugin template
  await copyTemplateUtil('plugin', pluginTargetDir);

  // Install dependencies
  await installDependencies(pluginTargetDir);

  console.info(`\n${colors.green('✓')} Plugin "${pluginDirName}" created successfully!`);
  console.info(`\nNext steps:`);
  console.info(`  cd ${pluginDirName}`);
  console.info(`  bun run build`);
  console.info(`  bun run test\n`);
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
    const confirmCreate = await clack.confirm({
      message: `Create agent "${agentName}" at ${agentFilePath}?`,
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
  isNonInteractive = false
): Promise<void> {
  const teeTargetDir = join(targetDir, projectName);

  // Validate target directory
  const dirResult = await validateTargetDirectory(teeTargetDir);
  if (!dirResult.isValid) {
    throw new Error(dirResult.error || 'Invalid target directory');
  }

  if (!isNonInteractive) {
    const confirmCreate = await clack.confirm({
      message: `Create TEE project "${projectName}" in ${teeTargetDir}?`,
    });

    if (clack.isCancel(confirmCreate) || !confirmCreate) {
      clack.cancel('TEE project creation cancelled.');
      process.exit(0);
    }
  }

  // Copy TEE template
  await copyTemplateUtil('project-tee-starter', teeTargetDir);

  // Set up project environment
  await setupProjectEnvironment(teeTargetDir, database, aiModel, isNonInteractive);

  // Install dependencies
  await installDependencies(teeTargetDir);

  // Build the project
  await buildProject(teeTargetDir);

  console.info(`\n${colors.green('✓')} TEE project "${projectName}" created successfully!`);

  // Display documentation link
  console.info(`\n${colors.cyan('📚 Learn more about ElizaOS:')}`);
  console.info(`   ${colors.blue('https://eliza.how')}\n`);

  // Only start the project if not in test mode
  if (process.env.ELIZA_TEST_MODE !== 'true') {
    if (!isNonInteractive) {
      const shouldStart = await clack.confirm({
        message: 'Would you like to start your TEE project now?',
        initialValue: true,
      });

      if (clack.isCancel(shouldStart) || !shouldStart) {
        console.info(`\nTo start your TEE project later:`);
        console.info(`  cd ${projectName}`);
        console.info(`  bun run dev\n`);
        return;
      }
    }

    console.info(`\n${colors.cyan('Starting your ElizaOS TEE project...')}\n`);

    // Start the project using spawn
    const startProcess = spawn('bun', ['run', 'dev'], {
      cwd: path.resolve(teeTargetDir),
      stdio: 'inherit',
      shell: true,
    });

    startProcess.on('error', (error) => {
      console.error(`\n${colors.red('Failed to start the TEE project:')}`);
      console.error(error.message);
      console.info(`\nYou can start it manually:`);
      console.info(`  cd ${projectName}`);
      console.info(`  bun run dev\n`);
    });

    // The process will continue running, so we don't need to wait for it
  } else {
    // In test mode, just show the manual start instructions
    console.info(`\nTo start your TEE project:`);
    console.info(`  cd ${projectName}`);
    console.info(`  bun run dev\n`);
  }
}

/**
 * Creates a new regular project with the specified name and configuration.
 */
export async function createProject(
  projectName: string,
  targetDir: string,
  database: string,
  aiModel: string,
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
    const confirmCreate = await clack.confirm({
      message: `Create project "${projectName}" in ${projectTargetDir}?`,
    });

    if (clack.isCancel(confirmCreate) || !confirmCreate) {
      clack.cancel('Project creation cancelled.');
      process.exit(0);
    }
  }

  // Copy project template
  await copyTemplateUtil('project-starter', projectTargetDir);

  // Set up project environment
  await setupProjectEnvironment(projectTargetDir, database, aiModel, isNonInteractive);

  // Install dependencies
  await installDependencies(projectTargetDir);

  // Build the project
  await buildProject(projectTargetDir);

  const displayName = projectName === '.' ? 'Project' : `Project "${projectName}"`;
  console.info(`\n${colors.green('✓')} ${displayName} initialized successfully!`);

  // Display documentation link
  console.info(`\n${colors.cyan('📚 Learn more about ElizaOS:')}`);
  console.info(`   ${colors.blue('https://eliza.how')}\n`);

  // Only start the project if not in test mode
  if (process.env.ELIZA_TEST_MODE !== 'true') {
    if (!isNonInteractive) {
      const shouldStart = await clack.confirm({
        message: 'Would you like to start your project now?',
        initialValue: true,
      });

      if (clack.isCancel(shouldStart) || !shouldStart) {
        console.info(`\nTo start your project later:`);
        console.info(`  cd ${projectName}`);
        console.info(`  bun run dev\n`);
        return;
      }
    }

    console.info(`\n${colors.cyan('Starting your ElizaOS project...')}\n`);

    // Start the project using spawn
    const startProcess = spawn('bun', ['run', 'dev'], {
      cwd: path.resolve(projectTargetDir),
      stdio: 'inherit',
      shell: true,
    });

    startProcess.on('error', (error) => {
      console.error(`\n${colors.red('Failed to start the project:')}`);
      console.error(error.message);
      console.info(`\nYou can start it manually:`);
      console.info(`  cd ${projectName}`);
      console.info(`  bun run dev\n`);
    });

    // The process will continue running, so we don't need to wait for it
  } else {
    // In test mode, just show the manual start instructions
    console.info(`\nTo start your project:`);
    console.info(`  cd ${projectName}`);
    console.info(`  bun run dev\n`);
  }
}

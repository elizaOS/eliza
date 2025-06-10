import { handleError } from '@/src/utils';
import { logger } from '@elizaos/core';
import { DevOptions } from '../types';
import { createDevContext, performInitialBuild, performRebuild } from '../utils/build-utils';
import { watchDirectory } from '../utils/file-watcher';
import { getServerManager } from '../utils/server-manager';

/**
 * Start development mode with file watching and auto-restart
 * 
 * Sets up a development environment with automatic rebuilding and server restarting when files change.
 */
export async function startDevMode(options: DevOptions): Promise<void> {
  const cwd = process.cwd();
  const context = createDevContext(cwd);
  const serverManager = getServerManager();

  const { directoryType } = context;
  const isProject = directoryType.type === 'elizaos-project';
  const isPlugin = directoryType.type === 'elizaos-plugin';
  const isMonorepo = directoryType.type === 'elizaos-monorepo';

  // Log project type
  if (isProject) {
    console.info('Identified as an ElizaOS project package');
  } else if (isPlugin) {
    console.info('Identified as an ElizaOS plugin package');
  } else if (isMonorepo) {
    console.info('Identified as an ElizaOS monorepo');
  } else {
    console.warn(
      `Not in a recognized ElizaOS project, plugin, or monorepo directory. Current directory is: ${directoryType.type}. Running in standalone mode.`
    );
  }

  // Prepare CLI arguments for the start command
  const cliArgs: string[] = [];

  // Pass through port option
  if (options.port) {
    cliArgs.push('--port', options.port.toString());
  }

  // Pass through configure option
  if (options.configure) {
    cliArgs.push('--configure');
  }

  // Handle characters - pass through to start command
  if (options.character) {
    if (Array.isArray(options.character)) {
      cliArgs.push('--character', ...options.character);
    } else {
      cliArgs.push('--character', options.character);
    }
  }

  // Function to rebuild and restart the server
  const rebuildAndRestart = async () => {
    try {
      // Ensure the server is stopped first
      await serverManager.stop();

      // Perform rebuild
      await performRebuild(context);

      console.log('✓ Rebuild successful, restarting...');

      // Start the server with the args
      await serverManager.start(cliArgs);
    } catch (error) {
      console.error(`Error during rebuild and restart: ${error.message}`);
      // Try to restart the server even if build fails
      if (!serverManager.process) {
        console.info('Attempting to restart server regardless of build failure...');
        await serverManager.start(cliArgs);
      }
    }
  };

  // Perform initial build if required
  if (isProject || isPlugin || isMonorepo) {
    const modeDescription = isMonorepo ? 'monorepo' : isProject ? 'project' : 'plugin';
    console.info(`Running in ${modeDescription} mode`);

    await performInitialBuild(context);
  }

  // Start the server initially
  await serverManager.start(cliArgs);

  // Set up file watching if we're in a project, plugin, or monorepo directory
  if (isProject || isPlugin || isMonorepo) {
    // Pass the rebuildAndRestart function as the onChange callback
    await watchDirectory(context.watchDirectory, rebuildAndRestart);

    console.log('Dev mode is active! The server will restart when files change.');
    console.log('Press Ctrl+C to exit');
  }
}
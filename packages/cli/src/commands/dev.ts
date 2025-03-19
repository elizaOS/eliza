import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProject } from '@/src/utils/build-project';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import { handleError } from '../utils/handle-error';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep track of the current server process
let serverProcess: ChildProcess | null = null;

/**
 * Stops the currently running server process
 */
async function stopServer(): Promise<void> {
  if (serverProcess) {
    logger.info('Stopping current server process...');

    // Send SIGTERM to the process group
    const killed = serverProcess.kill('SIGTERM');
    if (!killed) {
      logger.warn('Failed to kill server process, trying force kill...');
      serverProcess.kill('SIGKILL');
    }

    serverProcess = null;

    // Give the process a moment to fully terminate
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Starts the server process with the given arguments
 */
async function startServer(args: string[] = []): Promise<void> {
  await stopServer();

  logger.info('Starting server...');

  // We'll use the same executable that's currently running, with 'start' command
  const nodeExecutable = process.execPath;
  const scriptPath = process.argv[1]; // Current script path

  // Use spawn to create a process
  serverProcess = spawn(nodeExecutable, [scriptPath, 'start', ...args], {
    stdio: 'inherit',
    detached: false, // We want to keep control of this process
  });

  // Handle process exit events
  serverProcess.on('exit', (code, signal) => {
    if (code !== null) {
      if (code !== 0) {
        logger.warn(`Server process exited with code ${code}`);
      } else {
        logger.info('Server process exited normally');
      }
    } else if (signal) {
      logger.info(`Server process was killed with signal ${signal}`);
    }
    serverProcess = null;
  });

  // Handle process errors
  serverProcess.on('error', (err) => {
    logger.error(`Server process error: ${err.message}`);
    serverProcess = null;
  });
}

/**
 * Determines if the current directory is a project or plugin
 */
async function determineProjectType(): Promise<{ isProject: boolean; isPlugin: boolean }> {
  const cwd = process.cwd();
  const packageJsonPath = path.join(cwd, 'package.json');

  let isProject = false;
  let isPlugin = false;

  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // Log package info for debugging
      logger.info(`Package name: ${packageJson.name}`);
      logger.info(
        `Package type check: ${JSON.stringify({
          'eliza.type': packageJson.eliza?.type,
          'name.includes(plugin)': packageJson.name?.includes('plugin-'),
          keywords: packageJson.keywords,
        })}`
      );

      // Explicitly exclude the CLI package itself
      if (packageJson.name === '@elizaos/cli') {
        return { isProject: false, isPlugin: false };
      }

      // More specific check for plugins - must have one of these explicit indicators
      if (
        packageJson.eliza?.type === 'plugin' ||
        packageJson.name?.includes('plugin-') ||
        (packageJson.keywords &&
          Array.isArray(packageJson.keywords) &&
          packageJson.keywords.some((k: string) => k === 'elizaos-plugin' || k === 'eliza-plugin'))
      ) {
        isPlugin = true;
        logger.info('Identified as a plugin package');
      }

      // More specific check for projects
      if (
        packageJson.eliza?.type === 'project' ||
        (packageJson.name &&
          (packageJson.name.includes('project-') || packageJson.name.includes('-org'))) ||
        (packageJson.keywords &&
          Array.isArray(packageJson.keywords) &&
          packageJson.keywords.some(
            (k: string) => k === 'elizaos-project' || k === 'eliza-project'
          ))
      ) {
        isProject = true;
        logger.info('Identified as a project package');
      }

      // If still not identified, check if it has src/index.ts with a Project export
      if (!isProject && !isPlugin) {
        const indexPath = path.join(cwd, 'src', 'index.ts');
        if (fs.existsSync(indexPath)) {
          const indexContent = fs.readFileSync(indexPath, 'utf-8');
          if (
            indexContent.includes('export const project') ||
            (indexContent.includes('export default') && indexContent.includes('Project'))
          ) {
            isProject = true;
            logger.info('Identified as a project by src/index.ts export');
          }
        }
      }
    } catch (error) {
      logger.warn(`Error parsing package.json: ${error}`);
    }
  }

  return { isProject, isPlugin };
}

/**
 * Sets up file watching for the given directory
 */
async function watchDirectory(dir: string, onChange: () => void): Promise<void> {
  // First check if chokidar is installed
  try {
    await execa('npm', ['list', 'chokidar'], { stdio: 'ignore', reject: false });
  } catch (error) {
    // If chokidar isn't installed, install it
    logger.info('Installing chokidar dependency for file watching...');
    try {
      await execa('npm', ['install', 'chokidar', '--no-save'], { stdio: 'inherit' });
    } catch (installError) {
      logger.error(`Failed to install chokidar: ${installError.message}`);
      return;
    }
  }

  try {
    // Dynamically import chokidar
    const chokidar = await import('chokidar');

    // Get the absolute path of the directory
    const absoluteDir = path.resolve(dir);
    logger.info(`Setting up file watching for directory: ${absoluteDir}`);

    // Use a simpler approach - watch the src directory directly
    const srcDir = path.join(absoluteDir, 'src');
    const dirToWatch = fs.existsSync(srcDir) ? srcDir : absoluteDir;

    logger.info(`Actually watching directory: ${dirToWatch}`);

    // Define watch options with fewer exclusions to ensure we catch all changes
    const watchOptions = {
      ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      depth: 99, // Set high depth to ensure we catch all nested files
      usePolling: false, // Only use polling if necessary
      interval: 1000, // Poll every second
    };

    // Log file extensions we're watching
    logger.info(`Will watch files with extensions: .ts, .js, .tsx, .jsx`);

    // Create a more direct and simple watcher pattern
    const watcher = chokidar.watch(dirToWatch, {
      ...watchOptions,
    });

    // Manually find TypeScript files to verify we should be watching them
    const findTsFiles = (dir: string): string[] => {
      let results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== 'dist'
        ) {
          results = results.concat(findTsFiles(fullPath));
        } else if (
          entry.isFile() &&
          (entry.name.endsWith('.ts') ||
            entry.name.endsWith('.js') ||
            entry.name.endsWith('.tsx') ||
            entry.name.endsWith('.jsx'))
        ) {
          results.push(path.relative(dirToWatch, fullPath));
        }
      }
      return results;
    };

    const tsFiles = findTsFiles(dirToWatch);

    logger.info(`Found ${tsFiles.length} TypeScript/JavaScript files in the watched directory`);
    if (tsFiles.length > 0) {
      logger.info(
        `Sample files: ${tsFiles.slice(0, 3).join(', ')}${tsFiles.length > 3 ? '...' : ''}`
      );
    }

    let debounceTimer: any = null;

    // On ready handler
    watcher.on('ready', () => {
      const watchedPaths = watcher.getWatched();
      const pathsCount = Object.keys(watchedPaths).length;

      logger.info(`Chokidar is watching ${pathsCount} directories`);
      if (pathsCount === 0) {
        logger.warn('No directories are being watched! File watching may not be working.');

        // Try an alternative approach with explicit file patterns
        logger.info('Attempting to set up alternative file watching...');
        watcher.add(`${dirToWatch}/**/*.{ts,js,tsx,jsx}`);
      } else {
        logger.info(
          `Top-level watched directories: ${Object.keys(watchedPaths).slice(0, 5).join(', ')}${Object.keys(watchedPaths).length > 5 ? '...' : ''}`
        );
      }

      logger.success(`File watching initialized in: ${dirToWatch}`);
    });

    // Set up file change handler
    watcher.on('all', (event, filePath) => {
      // Only react to specific file types
      if (!/\.(ts|js|tsx|jsx)$/.test(filePath)) {
        return;
      }

      logger.info(`File event: ${event} - ${filePath}`);

      // Debounce the onChange handler to avoid multiple rapid rebuilds
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        logger.info(`Triggering rebuild for file change: ${filePath}`);
        onChange();
        debounceTimer = null;
      }, 300);
    });

    // Add an error handler
    watcher.on('error', (error) => {
      logger.error(`Chokidar watcher error: ${error}`);
    });

    // Ensure proper cleanup on process exit
    process.on('SIGINT', () => {
      watcher.close().then(() => process.exit(0));
    });

    logger.success(`Watching for file changes in ${dirToWatch}`);
  } catch (error: any) {
    logger.error(`Error setting up file watcher: ${error.message}`);
    logger.error(error.stack);
  }
}

/**
 * Create a command that runs start in watch mode with auto-restart
 */
export const dev = new Command()
  .name('dev')
  .description('Start the project or plugin in development mode and rebuild on file changes')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .option('-c, --configure', 'Reconfigure services and AI models (skips using saved configuration)')
  .option('--character <character>', 'Path or URL to character file to use instead of default')
  .option('--build', 'Build the project before starting')
  .action(async (options) => {
    try {
      const cwd = process.cwd();
      const { isProject, isPlugin } = await determineProjectType();

      // Prepare CLI arguments for the start command
      const cliArgs: string[] = [];
      if (options.port) cliArgs.push('--port', options.port.toString());
      if (options.configure) cliArgs.push('--configure');
      if (options.character) cliArgs.push('--character', options.character);

      // Function to rebuild and restart the server
      const rebuildAndRestart = async () => {
        try {
          // Ensure the server is stopped first
          await stopServer();

          logger.info('Rebuilding project after file change...');

          // Run the build process
          await buildProject(cwd, isPlugin);

          logger.success('Rebuild successful, restarting server...');

          // Start the server with the args
          await startServer(cliArgs);
        } catch (error) {
          logger.error(`Error during rebuild and restart: ${error.message}`);
          // Try to restart the server even if build fails
          if (!serverProcess) {
            logger.info('Attempting to restart server regardless of build failure...');
            await startServer(cliArgs);
          }
        }
      };

      if (!isProject && !isPlugin) {
        logger.warn('Not in a recognized project or plugin directory. Running in standalone mode.');
      } else {
        logger.info(`Running in ${isProject ? 'project' : 'plugin'} mode`);

        // Ensure initial build is performed
        logger.info('Building project...');
        try {
          await buildProject(cwd, isPlugin);
        } catch (error) {
          logger.error(`Initial build failed: ${error.message}`);
          logger.info('Continuing with dev mode anyway...');
        }
      }

      // Start the server initially
      await startServer(cliArgs);

      // Set up file watching only if we're in a project or plugin directory
      if (isProject || isPlugin) {
        // Pass the rebuildAndRestart function as the onChange callback
        await watchDirectory(cwd, rebuildAndRestart);

        logger.success(`Dev mode is active! The server will restart when files change.`);
        logger.success('Press Ctrl+C to exit');
      } else {
        logger.debug('Running in standalone mode without file watching.');
      }
    } catch (error) {
      handleError(error);
    }
  });

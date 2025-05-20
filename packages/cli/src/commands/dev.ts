import { buildProject, handleError, isMonorepoContext, UserEnvironment } from '@/src/utils';
import { Command, Option } from 'commander';
import chokidar from 'chokidar';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep track of the current server process
let serverProcess: ChildProcess | null = null;

/**
 * Stops the currently running server process
 */
async function stopServer(): Promise<void> {
  if (serverProcess) {
    console.info('Stopping current server process...');

    // Send SIGTERM to the process group
    const killed = serverProcess.kill('SIGTERM');
    if (!killed) {
      console.warn('Failed to kill server process, trying force kill...');
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

  console.info('Starting server...');

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
        console.warn(`Server process exited with code ${code}`);
      } else {
        console.info('Server process exited normally');
      }
    } else if (signal) {
      console.info(`Server process was killed with signal ${signal}`);
    }
    serverProcess = null;
  });

  // Handle process errors
  serverProcess.on('error', (err) => {
    console.error(`Server process error: ${err.message}`);
    serverProcess = null;
  });
}

/**
 * Determines whether the current working directory represents a project or a plugin.
 *
 * Examines `package.json` fields, naming conventions, keywords, and source exports to heuristically identify if the directory is an Eliza project or plugin.
 *
 * @returns An object indicating whether the directory is a project (`isProject`) or a plugin (`isPlugin`).
 */
async function determineProjectType(): Promise<{ isProject: boolean; isPlugin: boolean }> {
  const cwd = process.cwd();
  const packageJsonPath = path.join(cwd, 'package.json');
  const isMonorepo = await isMonorepoContext();

  console.info(`Running in directory: ${cwd}`);
  console.info(`Detected Eliza monorepo context: ${isMonorepo}`);

  let isProject = false;
  let isPlugin = false;

  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // Log package info for debugging
      console.info(`Package name: ${packageJson.name}`);
      console.info(
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
        console.info('Identified as a plugin package');
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
        console.info('Identified as a project package');
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
            console.info('Identified as a project by src/index.ts export');
          }
        }
      }
    } catch (error) {
      console.warn(`Error parsing package.json: ${error}`);
    }
  }

  return { isProject, isPlugin };
}

/**
 * Sets up file watching for the given directory
 */
async function watchDirectory(dir: string, onChange: () => void): Promise<void> {
  try {
    // Get the absolute path of the directory
    const absoluteDir = path.resolve(dir);
    console.info(`Setting up file watching for directory: ${absoluteDir}`);

    // Use a simpler approach - watch the src directory directly
    const srcDir = path.join(absoluteDir, 'src');
    const dirToWatch = fs.existsSync(srcDir) ? srcDir : absoluteDir;

    console.info(`Actually watching directory: ${dirToWatch}`);

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
    console.info('Will watch files with extensions: .ts, .js, .tsx, .jsx');

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

    console.info(`Found ${tsFiles.length} TypeScript/JavaScript files in the watched directory`);
    if (tsFiles.length > 0) {
      console.info(
        `Sample files: ${tsFiles.slice(0, 3).join(', ')}${tsFiles.length > 3 ? '...' : ''}`
      );
    }

    let debounceTimer: any = null;

    // On ready handler
    watcher.on('ready', () => {
      const watchedPaths = watcher.getWatched();
      const pathsCount = Object.keys(watchedPaths).length;

      console.info(`Chokidar is watching ${pathsCount} directories`);
      if (pathsCount === 0) {
        console.warn('No directories are being watched! File watching may not be working.');

        // Try an alternative approach with explicit file patterns
        console.info('Attempting to set up alternative file watching...');
        watcher.add(`${dirToWatch}/**/*.{ts,js,tsx,jsx}`);
      } else {
        console.info(
          `Top-level watched directories: ${Object.keys(watchedPaths).slice(0, 5).join(', ')}${Object.keys(watchedPaths).length > 5 ? '...' : ''}`
        );
      }

      console.log(`File watching initialized in: ${dirToWatch}`);
    });

    // Set up file change handler
    watcher.on('all', (event, filePath) => {
      // Only react to specific file types
      if (!/\.(ts|js|tsx|jsx)$/.test(filePath)) {
        return;
      }

      console.info(`File event: ${event} - ${filePath}`);

      // Debounce the onChange handler to avoid multiple rapid rebuilds
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        console.info(`Triggering rebuild for file change: ${filePath}`);
        onChange();
        debounceTimer = null;
      }, 300);
    });

    // Add an error handler
    watcher.on('error', (error) => {
      console.error(`Chokidar watcher error: ${error}`);
    });

    // Ensure proper cleanup on process exit
    process.on('SIGINT', () => {
      watcher.close().then(() => process.exit(0));
    });

    console.log(`Watching for file changes in ${dirToWatch}`);
  } catch (error: any) {
    console.error(`Error setting up file watcher: ${error.message}`);
    console.error(error.stack);
  }
}

/**
 * Create a command that runs start in watch mode with auto-restart
 */
export const dev = new Command()
  .name('dev')
  .description(
    'Start the project or plugin in development mode with auto-rebuild, detailed logging, and file change detection'
  )
  .option('-c, --configure', 'Reconfigure services and AI models (skips using saved configuration)')
  .option('-char, --character [paths...]', 'Character file(s) to use - accepts paths or URLs')
  .option('-b, --build', 'Build the project before starting')
  .addOption(
    new Option('-p, --port <port>', 'Port to listen on').argParser((val) => Number.parseInt(val))
  )
  .action(async (options) => {
    try {
      const cwd = process.cwd();
      const { isProject, isPlugin } = await determineProjectType();

      // Prepare CLI arguments for the start command
      const cliArgs: string[] = [];

      // Pass through port option
      if (options.port) {
        cliArgs.push('--port', options.port.toString());
        console.debug(`Using port: ${options.port}`);
      }

      // Pass through configure option
      if (options.configure) {
        cliArgs.push('--configure');
        console.debug('Using configure option');
      }

      // Handle characters - pass through to start command
      if (options.character) {
        if (Array.isArray(options.character)) {
          cliArgs.push('--character', ...options.character);
        } else {
          cliArgs.push('--character', options.character);
        }
        console.debug(`Using character(s): ${options.character}`);
      }

      // Pass through build option
      if (options.build) {
        cliArgs.push('--build');
        console.debug('Using build option');
      }

      // Function to rebuild and restart the server
      const rebuildAndRestart = async () => {
        try {
          // Ensure the server is stopped first
          await stopServer();

          console.info('Rebuilding project after file change...');

          const isMonorepo = await isMonorepoContext();

          if (isMonorepo) {
            const { monorepoRoot } = await UserEnvironment.getInstance().getPathInfo();
            if (monorepoRoot) {
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

              console.info('Building core monorepo packages...');
              for (const pkg of corePackages) {
                try {
                  console.info(`Building ${pkg.name}...`);
                  await buildProject(pkg.path, pkg.isPlugin);
                } catch (buildError) {
                  console.error(`Error building ${pkg.name}: ${buildError.message}`);
                  // Decide if we should stop or continue
                }
              }
            } else {
              console.warn('Monorepo context detected, but failed to find monorepo root.');
            }
          }

          // Build the current project/plugin
          console.info(`Building current package: ${cwd}`);
          await buildProject(cwd, isPlugin);

          console.log('Rebuild successful, restarting server...');

          // Start the server with the args
          await startServer(cliArgs);
        } catch (error) {
          console.error(`Error during rebuild and restart: ${error.message}`);
          // Try to restart the server even if build fails
          if (!serverProcess) {
            console.info('Attempting to restart server regardless of build failure...');
            await startServer(cliArgs);
          }
        }
      };

      if (!isProject && !isPlugin) {
        console.warn(
          'Not in a recognized project or plugin directory. Running in standalone mode.'
        );
      } else {
        console.info(`Running in ${isProject ? 'project' : 'plugin'} mode`);

        // Ensure initial build is performed
        console.info('Building project...');
        try {
          await buildProject(cwd, isPlugin);
        } catch (error) {
          console.error(`Initial build failed: ${error.message}`);
          console.info('Continuing with dev mode anyway...');
        }
      }

      // Start the server initially
      await startServer(cliArgs);

      // Set up file watching only if we're in a project or plugin directory
      if (isProject || isPlugin) {
        // Pass the rebuildAndRestart function as the onChange callback
        await watchDirectory(cwd, rebuildAndRestart);

        console.log('Dev mode is active! The server will restart when files change.');
        console.log('Press Ctrl+C to exit');
      } else {
        console.debug('Running in standalone mode without file watching.');
      }
    } catch (error) {
      handleError(error);
    }
  });

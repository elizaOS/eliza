import chokidar from 'chokidar';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WatcherConfig } from '../types';

/**
 * Default watcher configuration
 */
const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
  ignoreInitial: true,
  persistent: true,
  followSymlinks: false,
  depth: 99, // Set high depth to ensure we catch all nested files
  usePolling: false, // Only use polling if necessary
  interval: 1000, // Poll every second
};

/**
 * Find TypeScript/JavaScript files in a directory
 */
function findTsFiles(dir: string, watchDir: string): string[] {
  let results: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        entry.name !== 'dist'
      ) {
        results = results.concat(findTsFiles(fullPath, watchDir));
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') ||
          entry.name.endsWith('.js') ||
          entry.name.endsWith('.tsx') ||
          entry.name.endsWith('.jsx'))
      ) {
        results.push(path.relative(watchDir, fullPath));
      }
    }
  } catch (error) {
    // Ignore errors for directories we can't read
  }

  return results;
}

/**
 * Sets up file watching for the given directory
 *
 * Watches for changes to TypeScript and JavaScript files, with debouncing to prevent rapid rebuilds.
 */
export async function watchDirectory(
  dir: string,
  onChange: () => void,
  config: Partial<WatcherConfig> = {}
): Promise<void> {
  try {
    // Get the absolute path of the directory
    const absoluteDir = path.resolve(dir);

    // Use a simpler approach - watch the src directory directly
    const srcDir = path.join(absoluteDir, 'src');
    const dirToWatch = existsSync(srcDir) ? srcDir : absoluteDir;

    // Merge config with defaults
    const watchOptions = { ...DEFAULT_WATCHER_CONFIG, ...config };

    // Create a more direct and simple watcher pattern
    const watcher = chokidar.watch(dirToWatch, watchOptions);

    // Manually find TypeScript files to verify we should be watching them
    const tsFiles = findTsFiles(dirToWatch, dirToWatch);

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

      if (pathsCount === 0) {
        console.warn('No directories are being watched! File watching may not be working.');

        // Try an alternative approach with explicit file patterns
        watcher.add(`${dirToWatch}/**/*.{ts,js,tsx,jsx}`);
      }

      console.log(`✓ Watching for file changes in ${path.relative(process.cwd(), dirToWatch)}`);
    });

    // Set up file change handler
    watcher.on('all', (_event: string, filePath: string) => {
      // Only react to specific file types
      if (!/\.(ts|js|tsx|jsx)$/.test(filePath)) {
        return;
      }

      console.info(`File changed: ${path.relative(dirToWatch, filePath)}`);

      // Debounce the onChange handler to avoid multiple rapid rebuilds
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
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
  } catch (error: any) {
    console.error(`Error setting up file watcher: ${error.message}`);
  }
}

/**
 * Create a debounced file change handler
 */
export function createDebouncedHandler(handler: () => void, delay: number = 300): () => void {
  let timer: any = null;

  return () => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      handler();
      timer = null;
    }, delay);
  };
}

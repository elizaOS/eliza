import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WatcherConfig } from '../types';

/**
 * Default watcher configuration
 */
const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  ignored: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.git/**',
    '**/.elizadb/**',
    '**/coverage/**',
    '**/__tests__/**',
    '**/*.test.ts',
    '**/*.test.js',
    '**/*.spec.ts',
    '**/*.spec.js',
    '**/test/**',
    '**/tests/**',
    '**/.turbo/**',
    '**/tmp/**',
    '**/.cache/**',
    '**/*.log',
  ],
  ignoreInitial: true,
  persistent: true,
  followSymlinks: false,
  depth: 10, // Reasonable depth to avoid deep node_modules traversal
  usePolling: false, // Only use polling if necessary
  interval: 1000, // Poll every second
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 150,
  },
};

// Singleton watcher state
let activeWatcher: FSWatcher | null = null;
let activeWatchRoot: string | null = null;
let changeHandlerRef: ((event: string, filePath: string) => void) | null = null;
let readyLogged = false;

// Shared debounce timer to avoid stale timeouts across re-initializations
let globalDebounceTimer: NodeJS.Timeout | null = null;

function debounceAndRun(handler: () => void, delay: number = 500) {
  if (globalDebounceTimer) {
    clearTimeout(globalDebounceTimer);
  }
  globalDebounceTimer = setTimeout(() => {
    handler();
    globalDebounceTimer = null;
  }, delay);
}

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

    // Determine which directories to watch - prefer src if it exists
    const srcDir = path.join(absoluteDir, 'src');
    const watchPaths: string[] = [];

    if (existsSync(srcDir)) {
      // Watch specific file patterns in src directory only
      watchPaths.push(
        path.join(srcDir, '**/*.ts'),
        path.join(srcDir, '**/*.js'),
        path.join(srcDir, '**/*.tsx'),
        path.join(srcDir, '**/*.jsx')
      );
    } else {
      // Fallback: watch recursively from project root for nested files
      watchPaths.push(
        path.join(absoluteDir, '**/*.ts'),
        path.join(absoluteDir, '**/*.js'),
        path.join(absoluteDir, '**/*.tsx'),
        path.join(absoluteDir, '**/*.jsx')
      );
    }

    // Merge config with defaults
    const watchOptions = { ...DEFAULT_WATCHER_CONFIG, ...config };

    // If an active watcher exists for the same root, reuse it
    if (activeWatcher && activeWatchRoot === absoluteDir) {
      // Replace change handler to avoid duplicate triggers
      if (changeHandlerRef) {
        activeWatcher.off('all', changeHandlerRef);
      }
      // Clear any pending rebuilds from prior handler
      if (globalDebounceTimer) {
        clearTimeout(globalDebounceTimer);
        globalDebounceTimer = null;
      }
      changeHandlerRef = (event: string, filePath: string) => {
        if (!/\.(ts|js|tsx|jsx)$/.test(filePath)) return;
        const rel = path.relative(process.cwd(), filePath);
        if (event === 'change' || event === 'add' || event === 'unlink') {
          const action = event === 'add' ? 'added' : event === 'unlink' ? 'removed' : 'changed';
          console.info(`File ${action}: ${rel}`);
          debounceAndRun(onChange);
        }
      };
      activeWatcher.on('all', changeHandlerRef);
      return;
    }

    // Otherwise, close previous watcher (if any) and create new one
    if (activeWatcher) {
      try {
        await activeWatcher.close();
      } catch {
        // ignore close errors
      }
      activeWatcher = null;
      changeHandlerRef = null;
      readyLogged = false;
    }

    // Create watcher with specific file patterns
    const watcher = chokidar.watch(watchPaths, watchOptions);
    // Reduce event storms by awaiting write finish and limiting bursting restarts
    watcher.setMaxListeners(20);
    activeWatcher = watcher;
    activeWatchRoot = absoluteDir;

    // For debugging purposes - only log if DEBUG env is set
    if (process.env.DEBUG) {
      const watchDir = existsSync(srcDir) ? srcDir : absoluteDir;
      const tsFiles = findTsFiles(watchDir, watchDir);
      console.debug(
        `Found ${tsFiles.length} TypeScript/JavaScript files in ${path.relative(process.cwd(), watchDir)}`
      );
    }

    // debounceAndRun already defined above (shared)

    // On ready handler
    watcher.on('ready', () => {
      if (readyLogged) return;
      readyLogged = true;
      // Log only once when watcher is initially set up
      const watchPath = existsSync(srcDir)
        ? `${path.relative(process.cwd(), srcDir)}/**/*.{ts,js,tsx,jsx}`
        : `${path.relative(process.cwd(), absoluteDir)}/**/*.{ts,js,tsx,jsx}`;
      console.log(`✓ Watching for file changes in ${watchPath}`);
    });

    // Set up file change handler
    changeHandlerRef = (event: string, filePath: string) => {
      if (!/\.(ts|js|tsx|jsx)$/.test(filePath)) return;
      const rel = path.relative(process.cwd(), filePath);
      if (event === 'change' || event === 'add' || event === 'unlink') {
        const action = event === 'add' ? 'added' : event === 'unlink' ? 'removed' : 'changed';
        console.info(`File ${action}: ${rel}`);
        debounceAndRun(onChange);
      }
    };
    watcher.on('all', changeHandlerRef);

    // Add an error handler
    watcher.on('error', (error) => {
      console.error(`Chokidar watcher error: ${error}`);
    });

    // Ensure proper cleanup on process exit
    process.on('SIGINT', () => {
      watcher.close().then(() => process.exit(0));
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error setting up file watcher: ${msg}`);
  }
}

/**
 * Create a debounced file change handler
 */
export function createDebouncedHandler(handler: () => void, delay: number = 300): () => void {
  let timer: NodeJS.Timeout | null = null;

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

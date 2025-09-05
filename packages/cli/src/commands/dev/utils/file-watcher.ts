import chokidar from 'chokidar';
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
    '**/*.log'
  ],
  ignoreInitial: true,
  persistent: true,
  followSymlinks: false,
  depth: 10, // Reasonable depth to avoid deep node_modules traversal
  usePolling: false, // Only use polling if necessary
  interval: 1000, // Poll every second
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 100
  }
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
      // Fallback to watching specific patterns in the root directory
      watchPaths.push(
        path.join(absoluteDir, '*.ts'),
        path.join(absoluteDir, '*.js'),
        path.join(absoluteDir, '*.tsx'),
        path.join(absoluteDir, '*.jsx')
      );
    }

    // Merge config with defaults
    const watchOptions = { ...DEFAULT_WATCHER_CONFIG, ...config };

    // Create watcher with specific file patterns
    const watcher = chokidar.watch(watchPaths, watchOptions);

    // For debugging purposes - only log if DEBUG env is set
    if (process.env.DEBUG) {
      const watchDir = existsSync(srcDir) ? srcDir : absoluteDir;
      const tsFiles = findTsFiles(watchDir, watchDir);
      console.debug(`Found ${tsFiles.length} TypeScript/JavaScript files in ${path.relative(process.cwd(), watchDir)}`);
    }

    let debounceTimer: any = null;

    // On ready handler
    watcher.on('ready', () => {
      // Log only once when watcher is initially set up
      const watchPath = existsSync(srcDir) 
        ? `${path.relative(process.cwd(), srcDir)}/**/*.{ts,js,tsx,jsx}`
        : `${path.relative(process.cwd(), absoluteDir)}/*.{ts,js,tsx,jsx}`;
      
      console.log(`✓ Watching for file changes in ${watchPath}`);
    });

    // Set up file change handler
    watcher.on('all', (event: string, filePath: string) => {
      // The file type check is redundant since we're only watching specific extensions,
      // but we'll keep it as a safety measure
      if (!/\.(ts|js|tsx|jsx)$/.test(filePath)) {
        return;
      }

      // Only log file changes if not the initial add events
      if (event === 'change') {
        console.info(`File changed: ${path.relative(process.cwd(), filePath)}`);
      }

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

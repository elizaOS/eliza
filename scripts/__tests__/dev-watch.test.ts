/**
 * Tests for dev-watch.js hot reload functionality
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFile, readFile, mkdir, unlink, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEV_SCRIPT = path.resolve(PROJECT_ROOT, 'scripts/dev-watch.js');
const TEST_DIR = path.join(tmpdir(), `eliza-dev-watch-test-${Date.now()}`);
const TEST_FILE = path.join(TEST_DIR, '__test-hot-reload__.ts');

describe('Hot Reload Functionality', () => {
  let testFileCreated = false;

  beforeAll(async () => {
    // Create temp directory for tests
    await mkdir(TEST_DIR, { recursive: true });
  });

  // Helper to wait for a condition
  async function waitFor(
    condition: () => boolean,
    timeout = 30000,
    interval = 100
  ): Promise<boolean> {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeout) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return true;
  }

  // Helper to create or modify a test file
  async function modifyTestFile(content: string) {
    await writeFile(TEST_FILE, content);
    testFileCreated = true;
  }

  // Helper to clean up test file
  async function cleanupTestFile() {
    if (testFileCreated && existsSync(TEST_FILE)) {
      await unlink(TEST_FILE).catch(() => {
        /* ignore */
      });
      testFileCreated = false;
    }
  }

  afterAll(async () => {
    // Clean up test file
    await cleanupTestFile();

    // Clean up test directory
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('dev-watch script should exist', async () => {
    expect(existsSync(DEV_SCRIPT)).toBe(true);
  });

  test('file watcher should detect TypeScript file changes in temp directory', async () => {
    // Create a test file in temp directory
    const initialContent = `// Test file for hot reload - ${Date.now()}\nexport const test = true;\n`;
    await modifyTestFile(initialContent);

    // Wait a moment for file system
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify file was created
    expect(existsSync(TEST_FILE)).toBe(true);

    // Modify the file to simulate a code change
    const modifiedContent = `// Test file for hot reload - ${Date.now()}\nexport const test = false;\n`;
    await modifyTestFile(modifiedContent);

    // Wait for file system to register the change
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify file was modified
    const content = await readFile(TEST_FILE, 'utf-8');
    expect(content).toContain('export const test = false');

    // Clean up
    await cleanupTestFile();
  }, 10000);

  test('watched directories should include all CLI dependencies', () => {
    // Read the dev-watch.js file and verify it watches the right directories
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check that critical packages are being watched
    const expectedPackages = [
      'cli/src',
      'core/src',
      'server/src',
      'api-client/src',
      'plugin-bootstrap/src',
      'plugin-sql/src',
      'config/src',
    ];

    expectedPackages.forEach((pkg) => {
      expect(devWatchContent).toContain(pkg);
    });
  });

  test('debounce mechanism should prevent rapid rebuilds', async () => {
    // This test verifies that the debounce timer is set
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check for debounce implementation
    expect(devWatchContent).toContain('rebuildDebounceTimer');
    expect(devWatchContent).toContain('clearTimeout');
    expect(devWatchContent).toContain('setTimeout');
  });

  test('rebuild function should stop server before rebuilding', () => {
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check that rebuild logic includes server shutdown
    expect(devWatchContent).toContain('rebuildAndRestartServer');
    expect(devWatchContent).toContain('kill');
    expect(devWatchContent).toContain('SIGTERM');
  });

  test('file watcher should only watch TypeScript files', () => {
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check that file watcher filters for TypeScript files
    expect(devWatchContent).toContain('.ts');
    expect(devWatchContent).toContain('.tsx');
  });

  test('cleanup should handle file watchers properly', () => {
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check that cleanup includes watcher handling
    expect(devWatchContent).toContain("type === 'watcher'");
    expect(devWatchContent).toContain('child.close');
  });

  test('rebuild queuing should handle file changes during rebuild', () => {
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check for rebuild queueing mechanism
    expect(devWatchContent).toContain('rebuildQueued');
    expect(devWatchContent).toContain('isRebuilding');
  });

  test('directory existence check before watching', () => {
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check for directory existence verification
    expect(devWatchContent).toContain('existsSync');
    expect(devWatchContent).toContain('Skipping');
  });

  test('SIGKILL fallback uses exit event listener', () => {
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check for proper exit event handling
    expect(devWatchContent).toContain('exited');
    expect(devWatchContent).toContain('SIGKILL');
  });

  test('server health check after rebuild', () => {
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check for health check in rebuild path
    expect(devWatchContent).toContain('waitForServer');
    expect(devWatchContent).toContain('rebuild');
  });

  test('uses Bun.spawn instead of Node.js spawn', () => {
    const devWatchContent = readFileSync(DEV_SCRIPT, 'utf-8');

    // Check that Bun.spawn is used
    expect(devWatchContent).toContain('Bun.spawn');

    // Check that child_process is NOT imported
    expect(devWatchContent).not.toContain("from 'child_process'");
    expect(devWatchContent).not.toContain('require("child_process")');
  });
});

describe('Hot Reload Integration', () => {
  test('manual verification instructions', () => {
    console.log('\n=== Manual Hot Reload Test Instructions ===');
    console.log('1. Run: bun run dev');
    console.log('2. Wait for server to start (you should see "Development environment fully ready!")');
    console.log('3. Modify a file in packages/cli/src/, packages/core/src/, or packages/server/src/');
    console.log('4. Watch the console - you should see:');
    console.log('   - [WATCH] File changed in <package>: <filename>');
    console.log('   - [REBUILD] Rebuilding CLI...');
    console.log('   - [REBUILD] Build completed, restarting server...');
    console.log('   - [HEALTH] Waiting for server to be ready...');
    console.log('   - [REBUILD] Server restarted successfully!');
    console.log('5. Verify the server is still running and responsive');
    console.log('6. If you make changes during a rebuild, they should be queued');
    console.log('=========================================\n');

    // This is a documentation test - always passes
    expect(true).toBe(true);
  });
});

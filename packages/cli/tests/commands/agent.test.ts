import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, execSync } from 'child_process';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { waitForServerReady } from './test-utils';

describe('ElizaOS Agent Commands', () => {
  let serverProcess: any;
  let testTmpDir: string;
  let testServerPort: string;
  let testServerUrl: string;
  let elizaosCmd: string;

  beforeAll(async () => {
    // Setup test environment
    testServerPort = '3000';
    testServerUrl = `http://localhost:${testServerPort}`;
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-agent-'));

    // Setup CLI command
    const scriptDir = join(__dirname, '..');
    elizaosCmd = `bun ${join(scriptDir, '../dist/index.js')}`;

    // Kill any existing processes on port 3000
    try {
      if (process.platform === 'win32') {
        // Windows: Use netstat and taskkill to free the port
        // Note: The single percent sign (%a) is correct for inline execution via execSync.
        // If this logic is moved into a batch file, double percent signs (%%a) would be required.
        execSync(
          `for /f "tokens=5" %a in ('netstat -aon ^| findstr :3000') do taskkill /f /pid %a`,
          { stdio: 'ignore' }
        );
      } else {
        // Unix/Linux/macOS: Use lsof and kill
        execSync(`lsof -t -i :3000 | xargs kill -9`, { stdio: 'ignore' });
      }
      await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
    } catch (e) {
      // Ignore if no processes found
    }

    // Create database directory
    await mkdir(join(testTmpDir, 'elizadb'), { recursive: true });

    // Start the ElizaOS server
    console.log(`[DEBUG] Starting ElizaOS server on port ${testServerPort}`);

    serverProcess = spawn(
      'bun',
      [join(scriptDir, '../dist/index.js'), 'start', '--port', testServerPort],
      {
        env: {
          ...process.env,
          LOG_LEVEL: 'debug',
          PGLITE_DATA_DIR: `${testTmpDir}/elizadb`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    // Wait for server to be ready
    console.log('[DEBUG] Waiting for server to be ready...');
    await waitForServerReady(parseInt(testServerPort, 10));
    console.log('[DEBUG] Server is ready!');

    // Pre-load test characters
    const charactersDir = join(scriptDir, 'test-characters');
    for (const character of ['ada', 'max', 'shaw']) {
      const characterPath = join(charactersDir, `${character}.json`);
      console.log(`[DEBUG] Loading character: ${character}`);

      try {
        execSync(
          `${elizaosCmd} agent start --remote-url ${testServerUrl} --path ${characterPath}`,
          {
            stdio: 'pipe',
          }
        );
        console.log(`[DEBUG] Successfully loaded character: ${character}`);
      } catch (e) {
        console.error(`[ERROR] Failed to load character ${character}:`, e);
        throw e;
      }
    }

    // Give characters time to register
    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
  });

  afterAll(async () => {
    if (serverProcess) {
      try {
        if (process.platform === 'win32') {
          // On Windows, use SIGKILL for more reliable termination
          serverProcess.kill('SIGKILL');
        } else {
          serverProcess.kill();
        }
        await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.SHORT_WAIT));
        
        // Wait for process to actually exit
        if (!serverProcess.killed && serverProcess.exitCode === null) {
          await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUTS.PROCESS_CLEANUP));
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    if (testTmpDir) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  test('agent help displays usage information', async () => {
    const result = execSync(`${elizaosCmd} agent --help`, { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos agent');
  });

  test('agent list returns agents', async () => {
    const result = execSync(`${elizaosCmd} agent list --remote-url ${testServerUrl}`, {
      encoding: 'utf8',
    });
    expect(result).toMatch(/(Ada|Max|Shaw)/);
  });

  test('agent list works with JSON flag', async () => {
    const result = execSync(`${elizaosCmd} agent list --remote-url ${testServerUrl} --json`, {
      encoding: 'utf8',
    });
    expect(result).toContain('[');
    expect(result).toContain('{');
    expect(result).toMatch(/(name|Name)/);
  });

  test('agent get shows details with name parameter', async () => {
    const result = execSync(`${elizaosCmd} agent get --remote-url ${testServerUrl} -n Ada`, {
      encoding: 'utf8',
    });
    expect(result).toContain('Ada');
  });

  test('agent get with JSON flag shows character definition', async () => {
    const result = execSync(`${elizaosCmd} agent get --remote-url ${testServerUrl} -n Ada --json`, {
      encoding: 'utf8',
    });
    expect(result).toMatch(/(name|Name)/);
    expect(result).toContain('Ada');
  });

  test('agent get with output flag saves to file', async () => {
    const outputFile = join(testTmpDir, 'output_ada.json');
    execSync(
      `${elizaosCmd} agent get --remote-url ${testServerUrl} -n Ada --output ${outputFile}`,
      { encoding: 'utf8' }
    );

    const { readFile } = await import('fs/promises');
    const fileContent = await readFile(outputFile, 'utf8');
    expect(fileContent).toContain('Ada');
  });

  test('agent start loads character from file', async () => {
    const charactersDir = join(__dirname, '../test-characters');
    const adaPath = join(charactersDir, 'ada.json');

    try {
      const result = execSync(
        `${elizaosCmd} agent start --remote-url ${testServerUrl} --path ${adaPath}`,
        { encoding: 'utf8' }
      );
      expect(result).toMatch(/(started successfully|created|already exists|already running)/);
    } catch (e: any) {
      // If it fails, check if it's because agent already exists
      expect(e.stdout || e.stderr).toMatch(/(already exists|already running)/);
    }
  });

  test('agent start works with name parameter', async () => {
    try {
      execSync(`${elizaosCmd} agent start --remote-url ${testServerUrl} -n Ada`, {
        encoding: 'utf8',
      });
      // Should succeed or already exist
    } catch (e: any) {
      expect(e.stdout || e.stderr).toMatch(/already/);
    }
  });

  test('agent start handles non-existent agent fails', async () => {
    const nonExistentName = `NonExistent_${Date.now()}`;

    try {
      execSync(`${elizaosCmd} agent start --remote-url ${testServerUrl} -n ${nonExistentName}`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      // Should not reach here
      expect(false).toBe(true);
    } catch (e: any) {
      // The command should fail when agent doesn't exist
      expect(e.status).not.toBe(0);
    }
  });

  test('agent stop works after start', async () => {
    // Ensure Ada is started first
    try {
      execSync(`${elizaosCmd} agent start --remote-url ${testServerUrl} -n Ada`, { stdio: 'pipe' });
    } catch (e) {
      // May already be running
    }

    try {
      const result = execSync(`${elizaosCmd} agent stop --remote-url ${testServerUrl} -n Ada`, {
        encoding: 'utf8',
      });
      expect(result).toMatch(/(stopped|Stopped)/);
    } catch (e: any) {
      expect(e.stdout || e.stderr).toMatch(/(not running|not found)/);
    }
  });

  test('agent set updates configuration correctly', async () => {
    const configFile = join(testTmpDir, 'update_config.json');
    const configContent = JSON.stringify({
      system: 'Updated system prompt for testing',
    });

    const { writeFile } = await import('fs/promises');
    await writeFile(configFile, configContent);

    const result = execSync(
      `${elizaosCmd} agent set --remote-url ${testServerUrl} -n Ada -f ${configFile}`,
      { encoding: 'utf8' }
    );
    expect(result).toMatch(/(updated|Updated)/);
  });

  test('agent full lifecycle management', async () => {
    // Start agent
    try {
      execSync(`${elizaosCmd} agent start --remote-url ${testServerUrl} -n Ada`, {
        encoding: 'utf8',
      });
      // Should succeed or already exist
    } catch (e: any) {
      expect(e.stdout || e.stderr).toMatch(/already/);
    }

    // Stop agent
    try {
      execSync(`${elizaosCmd} agent stop --remote-url ${testServerUrl} -n Ada`, {
        encoding: 'utf8',
      });
      // Should succeed or not be running
    } catch (e: any) {
      expect(e.stdout || e.stderr).toMatch(/not running/);
    }
  });
});

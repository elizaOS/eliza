import { execSync } from 'child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { TEST_TIMEOUTS } from '../test-timeouts';

export interface TestContext {
  testTmpDir: string;
  elizaosCmd: string;
  originalCwd: string;
}

/**
 * Standard setup for CLI tests - creates temp directory and sets up CLI command
 */
export async function setupTestEnvironment(): Promise<TestContext> {
  const originalCwd = process.cwd();
  const testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-'));
  process.chdir(testTmpDir);

  const scriptDir = join(__dirname, '../..');
  const scriptPath = join(scriptDir, 'dist/index.js');
  const elizaosCmd = `bun run "${scriptPath}"`;

  return { testTmpDir, elizaosCmd, originalCwd };
}

/**
 * Standard cleanup for CLI tests - restores directory and removes temp files
 */
export async function cleanupTestEnvironment(context: TestContext): Promise<void> {
  safeChangeDirectory(context.originalCwd);

  if (context.testTmpDir && context.testTmpDir.includes('eliza-test-')) {
    try {
      await rm(context.testTmpDir, { recursive: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Safe directory change helper that handles missing directories
 */
export function safeChangeDirectory(targetDir: string): void {
  if (existsSync(targetDir)) {
    try {
      process.chdir(targetDir);
    } catch (e) {
      try {
        process.chdir(tmpdir());
      } catch (e2) {
        // Ignore if we can't change to temp dir
      }
    }
  } else {
    try {
      process.chdir(tmpdir());
    } catch (e) {
      // Ignore if we can't change to temp dir
    }
  }
}

/**
 * Helper to create a basic ElizaOS project for testing
 */
export async function createTestProject(elizaosCmd: string, projectName: string): Promise<void> {
  execSync(`${elizaosCmd} create ${projectName} --yes`, {
    stdio: 'pipe',
    timeout: TEST_TIMEOUTS.PROJECT_CREATION,
  });
  process.chdir(projectName);
}

/**
 * Helper to run CLI command and expect it to succeed
 */
export function runCliCommand(
  elizaosCmd: string,
  args: string,
  options: { timeout?: number } = {}
): string {
  return execSync(`${elizaosCmd} ${args}`, {
    encoding: 'utf8',
    timeout: options.timeout || TEST_TIMEOUTS.STANDARD_COMMAND,
  });
}

/**
 * Helper to run CLI command silently (suppressing console output)
 */
export function runCliCommandSilently(
  elizaosCmd: string,
  args: string,
  options: { timeout?: number } = {}
): string {
  return execSync(`${elizaosCmd} ${args}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeout || TEST_TIMEOUTS.STANDARD_COMMAND,
  });
}

/**
 * Helper to run CLI command and expect it to fail
 */
export function expectCliCommandToFail(
  elizaosCmd: string,
  args: string,
  options: { timeout?: number } = {}
): { status: number; output: string } {
  try {
    const result = execSync(`${elizaosCmd} ${args}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: options.timeout || TEST_TIMEOUTS.STANDARD_COMMAND,
    });
    throw new Error(`Command should have failed but succeeded with output: ${result}`);
  } catch (e: any) {
    return {
      status: e.status || -1,
      output: (e.stdout || '') + (e.stderr || ''),
    };
  }
}

/**
 * Helper to validate that help output contains expected strings
 */
export function expectHelpOutput(
  output: string,
  command: string,
  expectedOptions: string[] = []
): void {
  if (!output.includes(`Usage: elizaos ${command}`)) {
    throw new Error(`Expected help output to contain 'Usage: elizaos ${command}', got: ${output}`);
  }

  for (const option of expectedOptions) {
    if (!output.includes(option)) {
      throw new Error(`Expected help output to contain '${option}', got: ${output}`);
    }
  }
}

/**
 * Helper to create a test plugin directory structure
 */
export async function createTestPluginStructure(pluginName: string): Promise<void> {
  const pluginDir = `plugin-${pluginName}`;
  await mkdir(pluginDir, { recursive: true });
  await mkdir(join(pluginDir, 'src'), { recursive: true });

  // Create basic package.json
  const packageJson = {
    name: `@elizaos/plugin-${pluginName}`,
    version: '1.0.0',
    type: 'module',
    main: 'dist/index.js',
    elizaPlugin: true,
  };

  await writeFile(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2));
  await writeFile(join(pluginDir, 'src/index.ts'), 'export default {};');

  process.chdir(pluginDir);
}

/**
 * Helper to create a basic agent JSON file
 */
export async function createTestAgent(agentName: string): Promise<void> {
  const agentData = {
    name: agentName,
    system: 'You are a helpful assistant.',
    bio: ['I am a test agent'],
    messageExamples: [
      [{ user: 'user', content: { text: 'Hello' } }],
      [{ user: 'assistant', content: { text: 'Hi there!' } }],
    ],
    style: {
      all: ['helpful', 'friendly'],
    },
  };

  await writeFile(`${agentName}.json`, JSON.stringify(agentData, null, 2));
}

/**
 * Common assertions for CLI tests
 */
export const assertions = {
  /**
   * Assert that output matches one of several possible patterns
   */
  matchesAny(output: string, patterns: RegExp[]): void {
    const matches = patterns.some((pattern) => pattern.test(output));
    if (!matches) {
      throw new Error(`Output did not match any expected patterns. Output: ${output}`);
    }
  },

  /**
   * Assert that command output indicates success
   */
  isSuccessOutput(output: string): void {
    const successPatterns = [/successfully/i, /complete/i, /created/i, /installed/i, /updated/i];

    this.matchesAny(output, successPatterns);
  },

  /**
   * Assert that file exists
   */
  fileExists(filePath: string): void {
    if (!existsSync(filePath)) {
      throw new Error(`Expected file to exist: ${filePath}`);
    }
  },
};

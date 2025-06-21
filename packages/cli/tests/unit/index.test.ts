import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock all dependencies before importing
vi.mock('@/src/commands/create', () => ({
  create: new Command('create').description('Mocked create command'),
}));

vi.mock('@/src/commands/start', () => ({
  start: new Command('start').description('Mocked start command'),
}));

vi.mock('@/src/commands/test', () => ({
  test: new Command('test').description('Mocked test command'),
}));

vi.mock('@/src/commands/update', () => ({
  update: new Command('update').description('Mocked update command'),
}));

vi.mock('@/src/commands/env', () => ({
  env: new Command('env').description('Mocked env command'),
}));

vi.mock('@/src/commands/monorepo', () => ({
  monorepo: new Command('monorepo').description('Mocked monorepo command'),
}));

vi.mock('@/src/commands/dev', () => ({
  dev: new Command('dev').description('Mocked dev command'),
}));

vi.mock('@/src/commands/agent', () => ({
  agent: new Command('agent').description('Mocked agent command'),
}));

vi.mock('@/src/commands/plugins', () => ({
  plugins: new Command('plugins').description('Mocked plugins command'),
}));

vi.mock('@/src/commands/publish', () => ({
  publish: new Command('publish').description('Mocked publish command'),
}));

vi.mock('@/src/commands/tee', () => ({
  teeCommand: new Command('tee').description('Mocked tee command'),
}));

// Mock utilities
const mockDisplayBanner = vi.fn().mockResolvedValue(undefined);
const mockHandleError = vi.fn();
const mockGetVersion = vi.fn().mockReturnValue('1.0.0-test');
const mockCheckAndShowUpdateNotification = vi.fn().mockResolvedValue(undefined);

vi.mock('@/src/utils', () => ({
  displayBanner: mockDisplayBanner,
  handleError: mockHandleError,
  getVersion: mockGetVersion,
  checkAndShowUpdateNotification: mockCheckAndShowUpdateNotification,
}));

vi.mock('@/src/project', () => ({
  loadProject: vi.fn(),
}));

vi.mock('@/src/version', () => ({
  version: '1.0.0-test',
}));

// Mock fs
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0-test' })),
  },
}));

// Mock logger
vi.mock('@elizaos/core', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
  VECTOR_DIMS: 1536,
  DatabaseAdapter: class MockDatabaseAdapter {},
  Service: class MockService {},
}));

// Mock emoji-handler
const mockConfigureEmojis = vi.fn();
vi.mock('@/src/utils/emoji-handler', () => ({
  configureEmojis: mockConfigureEmojis,
}));

// Mock child_process for stop command
vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd, callback) => callback?.(null)),
}));

describe('CLI main index', () => {
  let mockExit: any;
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    // Save original values
    originalArgv = [...process.argv];
    originalEnv = { ...process.env };
    // Mock process.exit
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    // Restore original values
    process.argv = originalArgv;
    process.env = originalEnv;
    mockExit.mockRestore();
    // Clear module cache to allow re-importing
    vi.resetModules();
  });

  it('should configure emoji settings when --no-emoji flag is present', async () => {
    process.argv = ['node', 'elizaos', '--no-emoji'];

    // Import and run the CLI
    await import('../../src/index');

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockConfigureEmojis).toHaveBeenCalledWith({ forceDisable: true });
  });

  it('should set ELIZA_NO_AUTO_INSTALL when --no-auto-install flag is present', async () => {
    process.argv = ['node', 'elizaos', '--no-auto-install'];

    await import('../../src/index');

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(process.env.ELIZA_NO_AUTO_INSTALL).toBe('true');
  });

  it('should display banner when no arguments provided', async () => {
    process.argv = ['node', 'elizaos'];

    await import('../../src/index');

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDisplayBanner).toHaveBeenCalledWith(false);
  });

  it('should handle errors and exit with code 1', async () => {
    process.argv = ['node', 'elizaos', 'invalid-command'];

    await import('../../src/index');

    // Wait for async operations and error handling
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

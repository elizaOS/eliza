import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Mock all the command imports
vi.mock('../../../src/commands/create', () => ({
  create: new Command('create').description('Mocked create command')
}));

vi.mock('../../../src/commands/start', () => ({
  start: new Command('start').description('Mocked start command')
}));

vi.mock('../../../src/commands/test', () => ({
  test: new Command('test').description('Mocked test command')
}));

vi.mock('../../../src/commands/update', () => ({
  update: new Command('update').description('Mocked update command')
}));

vi.mock('../../../src/commands/env', () => ({
  env: new Command('env').description('Mocked env command')
}));

vi.mock('../../../src/commands/monorepo', () => ({
  monorepo: new Command('monorepo').description('Mocked monorepo command')
}));

vi.mock('../../../src/commands/dev', () => ({
  dev: new Command('dev').description('Mocked dev command')
}));

vi.mock('../../../src/commands/agent', () => ({
  agent: new Command('agent').description('Mocked agent command')
}));

vi.mock('../../../src/commands/plugins', () => ({
  plugins: new Command('plugins').description('Mocked plugins command')
}));

vi.mock('../../../src/commands/publish', () => ({
  publish: new Command('publish').description('Mocked publish command')
}));

vi.mock('../../../src/commands/tee', () => ({
  teeCommand: new Command('tee').description('Mocked tee command')
}));

vi.mock('../../../src/utils', () => ({
  displayBanner: vi.fn().mockResolvedValue(undefined),
  handleError: vi.fn()
}));

vi.mock('../../../src/project', () => ({
  loadProject: vi.fn()
}));

vi.mock('../../../src/version', () => ({
  version: '1.0.0-test'
}));

// Mock process.exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit called');
});

// Mock fs
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0-test' }))
  }
}));

// Mock logger
vi.mock('@elizaos/core', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn()
  }
}));

// Mock emoji-handler
vi.mock('../../../src/utils/emoji-handler', () => ({
  configureEmojis: vi.fn()
}));

// Mock commander parseAsync
vi.mock('commander', async () => {
  const actual = await vi.importActual<typeof import('commander')>('commander');
  return {
    ...actual,
    Command: class MockCommand extends actual.Command {
      parseAsync() {
        return Promise.resolve(this);
      }
    }
  };
});

describe('CLI main index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset process.argv
    process.argv = ['node', 'elizaos'];
  });

  it('should configure emoji settings when --no-emoji flag is present', async () => {
    process.argv = ['node', 'elizaos', '--no-emoji'];
    
    const { configureEmojis } = await import('../../src/utils/emoji-handler');
    
    // Import will trigger main()
    await import('../../src/index');
    
    expect(configureEmojis).toHaveBeenCalledWith({ forceDisable: true });
  });

  it('should set ELIZA_NO_AUTO_INSTALL when --no-auto-install flag is present', async () => {
    process.argv = ['node', 'elizaos', '--no-auto-install'];
    
    await import('../../src/index');
    
    expect(process.env.ELIZA_NO_AUTO_INSTALL).toBe('true');
  });

  it('should display banner when no arguments provided', async () => {
    process.argv = ['node', 'elizaos'];
    
    await import('../../src/index');
    
    const { displayBanner } = await import('../../src/utils');
    expect(displayBanner).toHaveBeenCalledWith(false);
  });

  it('should handle errors and exit with code 1', async () => {
    const { logger } = await import('@elizaos/core');
    
    // Force an error by making parseAsync throw
    vi.mock('commander', async () => {
      const actual = await vi.importActual<typeof import('commander')>('commander');
      return {
        ...actual,
        Command: class MockCommand extends actual.Command {
          parseAsync(): Promise<this> {
            return Promise.reject(new Error('Test error'));
          }
        }
      };
    });
    
    try {
      await import('../../src/index');
    } catch (e) {
      // Expected
    }
    
    expect(logger.error).toHaveBeenCalledWith('An error occurred:', expect.any(Error));
    expect(mockExit).toHaveBeenCalledWith(1);
  });
}); 
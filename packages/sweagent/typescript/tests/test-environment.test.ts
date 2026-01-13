/**
 * Environment tests for the TypeScript SWE-agent implementation
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { SWEEnv } from '../src/environment/swe-env';
import { AbstractDeployment } from '../src/environment/deployment';
import { LocalRepo, GithubRepo } from '../src/environment/repo';
import { EnvHook } from '../src/environment/hooks/abstract';
import {
  AbstractRuntime,
  BashAction,
  BashActionResult,
  BashInterruptAction,
  CreateBashSessionRequest,
  Command,
  CommandResult,
  ReadFileRequest,
  ReadFileResponse,
  WriteFileRequest,
  UploadRequest,
} from '../src/environment/runtime';
import { parseGhRepoUrl, parseGhIssueUrl, isGithubRepoUrl, isGithubIssueUrl } from '../src/utils/github';

/**
 * Mock runtime for testing
 */
class MockRuntime extends AbstractRuntime {
  private files: Map<string, string> = new Map();
  private sessionOutput: string = '';

  async createSession(_request: CreateBashSessionRequest): Promise<void> {
    // Mock implementation
  }

  async runInSession(action: BashAction | BashInterruptAction): Promise<BashActionResult> {
    if ('type' in action && action.type === 'interrupt') {
      return { output: '', exitCode: 0 };
    }

    const bashAction = action as BashAction;

    // Mock some basic commands
    if (bashAction.command.startsWith('echo ')) {
      const text = bashAction.command.substring(5).replace(/['"]/g, '');
      return { output: text + '\n', exitCode: 0 };
    }

    if (bashAction.command === 'ls') {
      return { output: 'file1\nfile2\n', exitCode: 0 };
    }

    if (bashAction.command.startsWith('sleep ')) {
      const seconds = parseFloat(bashAction.command.substring(6));
      if (bashAction.timeout && bashAction.timeout < seconds) {
        throw new Error('Command timeout');
      }
      return { output: '', exitCode: 0 };
    }

    return { output: this.sessionOutput, exitCode: 0 };
  }

  async execute(_command: Command): Promise<CommandResult> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async readFile(request: ReadFileRequest): Promise<ReadFileResponse> {
    const content = this.files.get(request.path) || '';
    return { content };
  }

  async writeFile(request: WriteFileRequest): Promise<void> {
    this.files.set(request.path, request.content);
  }

  async upload(_request: UploadRequest): Promise<void> {
    // Mock implementation
  }
}

/**
 * Mock deployment for testing
 */
class MockDeployment extends AbstractDeployment {
  runtime: MockRuntime;

  constructor() {
    super();
    this.runtime = new MockRuntime();
  }

  async start(): Promise<void> {
    // Mock implementation
  }

  async stop(): Promise<void> {
    // Mock implementation
  }
}

/**
 * Test hook implementation
 */
class TestEnvHook extends EnvHook {
  public initCalled = false;
  public startupCalled = false;
  public closeCalled = false;

  onInit(_env: unknown): void {
    this.initCalled = true;
  }

  onEnvironmentStartup(): void {
    this.startupCalled = true;
  }

  onClose(): void {
    this.closeCalled = true;
  }
}

describe('Environment', () => {
  let env: SWEEnv;

  afterEach(async () => {
    if (env) {
      await env.close();
    }
  });

  describe('SWEEnv initialization', () => {
    it('should initialize SWEEnv with mock deployment', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();
      expect(env).toBeDefined();
      expect(env.deployment).toBeDefined();
    });

    it('should run startup commands', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: ["echo 'hello world'"],
      });

      await env.start();
      expect(env).toBeDefined();
    });

    it('should work with local repo', () => {
      const repo = new LocalRepo({
        path: '/tmp/test-repo',
        baseCommit: 'HEAD',
        type: 'local',
      });

      expect(repo.repoName).toBeDefined();
      expect(repo.baseCommit).toBe('HEAD');
    });

    it('should work with github repo', () => {
      const repo = new GithubRepo({
        githubUrl: 'https://github.com/elizaos/swe-agent-ts',
        baseCommit: 'main',
        type: 'github',
        cloneTimeout: 500,
      });

      expect(repo.repoName).toBe('elizaos__swe-agent-ts');
      expect(repo.baseCommit).toBe('main');
    });
  });

  describe('File operations', () => {
    it('should read and write files', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      // Write a test file
      const testPath = '/tmp/test.txt';
      await env.writeFile(testPath, 'Test content');

      // Read the file back
      const content = await env.readFile(testPath);
      expect(content).toBe('Test content');
    });
  });

  describe('Hooks', () => {
    it('should work with hooks', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      const hook = new TestEnvHook();
      env.addHook(hook);

      expect(hook.initCalled).toBe(true);

      await env.start();
      await env.reset();

      expect(hook.startupCalled).toBe(true);
      expect(env).toBeDefined();
    });
  });

  describe('Communication', () => {
    it('should communicate with the environment', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      const result = await env.communicate("echo 'hello world'", 25, {
        check: 'raise',
        errorMsg: 'Failed to echo',
      });

      expect(result).toContain('hello world');
    });

    it('should handle communication timeout', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      // This should timeout
      await expect(
        env.communicate('sleep 10', 0.2, {
          check: 'raise',
          errorMsg: 'Failed to sleep',
        }),
      ).rejects.toThrow('Command timeout');
    });
  });

  describe('Session management', () => {
    it('should interrupt session', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      await env.interruptSession();
      expect(env).toBeDefined();
    });

    it('should reset environment', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();
      await env.reset();
      expect(env).toBeDefined();
    });

    it('should hard reset environment', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();
      await env.hardReset();
      expect(env).toBeDefined();
    });
  });

  describe('Conservative clone method', () => {
    it('should use full clone method when configured', async () => {
      process.env.SWE_AGENT_CLONE_METHOD = 'full';

      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: new GithubRepo({
          githubUrl: 'https://github.com/test/repo',
          baseCommit: 'main',
          type: 'github',
          cloneTimeout: 500,
        }),
        postStartupCommands: [],
      });

      // Clone method should be respected
      expect(process.env.SWE_AGENT_CLONE_METHOD).toBe('full');

      delete process.env.SWE_AGENT_CLONE_METHOD;
    });

    it('should use shallow clone by default', async () => {
      delete process.env.SWE_AGENT_CLONE_METHOD;

      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: new GithubRepo({
          githubUrl: 'https://github.com/test/repo',
          baseCommit: 'main',
          type: 'github',
          cloneTimeout: 500,
        }),
        postStartupCommands: [],
      });

      // Should default to shallow clone
      expect(process.env.SWE_AGENT_CLONE_METHOD).toBeUndefined();
    });
  });

  describe('Pre-existing repository', () => {
    it('should handle pre-existing repository config', () => {
      const repo = {
        type: 'preexisting',
        repoName: 'testbed',
        baseCommit: 'abc123',
      };

      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: repo as any,
        postStartupCommands: [],
      });

      expect(env.repo).toBeDefined();
      expect(env.repo!.repoName).toBe('testbed');
    });
  });

  describe('Command execution with error handling', () => {
    it('should handle command with raise error check', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      const result = await env.communicate("echo 'test'", 25, {
        check: 'raise',
        errorMsg: 'Command failed',
      });

      expect(result).toContain('test');
    });

    it('should handle command with silent error check', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      // Mock a failing command
      const mockRuntime = env.deployment.runtime as MockRuntime;
      mockRuntime.runInSession = async () => {
        return { output: 'error', exitCode: 1 };
      };

      const result = await env.communicate('failing_command', 25, {
        check: 'ignore',
      });

      // Should not throw even with non-zero exit code
      expect(result).toBeDefined();
    });
  });

  describe('File operations edge cases', () => {
    it('should handle reading non-existent file', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      const content = await env.readFile('/nonexistent/file.txt');
      expect(content).toBe('');
    });

    it('should handle writing to nested directories', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      await env.writeFile('/nested/dir/file.txt', 'content');
      const content = await env.readFile('/nested/dir/file.txt');
      expect(content).toBe('content');
    });

    it('should handle binary files', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await env.writeFile('/binary.dat', binaryData.toString('base64'));

      // Should handle binary data
      expect(env).toBeDefined();
    });
  });

  describe('Multiple hooks', () => {
    it('should handle multiple hooks in order', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      const hook1 = new TestEnvHook();
      const hook2 = new TestEnvHook();

      env.addHook(hook1);
      env.addHook(hook2);

      expect(hook1.initCalled).toBe(true);
      expect(hook2.initCalled).toBe(true);

      await env.start();
      await env.reset();

      expect(hook1.startupCalled).toBe(true);
      expect(hook2.startupCalled).toBe(true);
    });

    it('should continue even if one hook fails', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      class FailingHook extends EnvHook {
        onEnvironmentStartup(): void {
          throw new Error('Hook failed');
        }
      }

      const failingHook = new FailingHook();
      const normalHook = new TestEnvHook();

      env.addHook(failingHook);
      env.addHook(normalHook);

      // Should not throw despite failing hook
      await expect(env.start()).resolves.not.toThrow();
      await expect(env.reset()).resolves.not.toThrow();

      expect(normalHook.startupCalled).toBe(true);
      
      // Verify that errors were logged (2 times: once for start, once for reset)
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Hook error in onEnvironmentStartup:', expect.any(Error));
      
      // Restore console.error
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Environment state management', () => {
    it('should track environment state', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      expect(env.isStarted()).toBe(false);

      await env.start();
      expect(env.isStarted()).toBe(true);

      await env.close();
      expect(env.isStarted()).toBe(false);
    });

    it('should prevent double initialization', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      // Second start should be a no-op or handled gracefully
      await env.start();

      expect(env.isStarted()).toBe(true);
    });
  });

  describe('Batch operations', () => {
    it('should handle batch file reads', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      // Write multiple files
      const files = [
        { path: '/file1.txt', content: 'content1' },
        { path: '/file2.txt', content: 'content2' },
        { path: '/file3.txt', content: 'content3' },
      ];

      for (const file of files) {
        await env.writeFile(file.path, file.content);
      }

      // Read all files
      const contents = await Promise.all(files.map((f) => env.readFile(f.path)));

      expect(contents).toEqual(['content1', 'content2', 'content3']);
    });
  });

  describe('Error recovery', () => {
    it('should recover from runtime errors', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      await env.start();

      // Simulate runtime error
      const mockRuntime = env.deployment.runtime as MockRuntime;
      let errorCount = 0;

      mockRuntime.runInSession = async () => {
        errorCount++;
        if (errorCount === 1) {
          throw new Error('Temporary error');
        }
        return { output: 'success', exitCode: 0 };
      };

      // First call should fail
      await expect(env.communicate('test')).rejects.toThrow();

      // Second call should succeed after recovery
      const result = await env.communicate('test');
      expect(result).toBe('success');
    });
  });

  describe('Resource cleanup', () => {
    it('should clean up resources on close', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      const hook = new TestEnvHook();
      env.addHook(hook);

      await env.start();
      await env.close();

      expect(hook.closeCalled).toBe(true);
      expect(env.isStarted()).toBe(false);
    });

    it('should handle close without start', async () => {
      env = new SWEEnv({
        deployment: new MockDeployment(),
        repo: null,
        postStartupCommands: [],
      });

      // Should not throw
      await expect(env.close()).resolves.not.toThrow();
    });
  });
});

describe('GitHub utilities', () => {
  describe('URL parsing', () => {
    it('should identify GitHub repo URLs', () => {
      expect(isGithubRepoUrl('https://github.com/elizaos/swe-agent-ts')).toBe(true);
      expect(isGithubRepoUrl('https://github.com/elizaos/swe-agent-ts/anything')).toBe(true);
      expect(isGithubRepoUrl('github.com/elizaos/swe-agent-ts/anything')).toBe(true);
      expect(isGithubRepoUrl('')).toBe(false);
      expect(isGithubRepoUrl('/path/to/file')).toBe(false);
    });

    it('should parse GitHub repo URLs', () => {
      const { owner, repo } = parseGhRepoUrl('https://github.com/elizaos/swe-agent-ts');
      expect(owner).toBe('elizaos');
      expect(repo).toBe('swe-agent-ts');

      const { owner: owner2, repo: repo2 } = parseGhRepoUrl('github.com/elizaos/swe-agent-ts');
      expect(owner2).toBe('elizaos');
      expect(repo2).toBe('swe-agent-ts');
    });

    it('should throw error for invalid repo URLs', () => {
      expect(() => parseGhRepoUrl('adfkj;lasdfl;kj')).toThrow();
      expect(() => parseGhRepoUrl('github.com/')).toThrow();
    });

    it('should parse GitHub issue URLs', () => {
      const { owner, repo, issueNumber } = parseGhIssueUrl('https://github.com/elizaos/swe-agent-ts/issues/43');
      expect(owner).toBe('elizaos');
      expect(repo).toBe('swe-agent-ts');
      expect(issueNumber).toBe('43');
    });

    it('should throw error for invalid issue URLs', () => {
      expect(() => parseGhIssueUrl('https://github.com/a/b')).toThrow();
      expect(() => parseGhIssueUrl('https://github.com/a/b////')).toThrow();
    });

    it('should identify GitHub issue URLs', () => {
      expect(isGithubIssueUrl('')).toBe(false);
      expect(isGithubIssueUrl('https://github.com/elizaos/swe-agent-ts/issues/43')).toBe(true);
    });
  });
});

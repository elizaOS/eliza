import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubClient, GitHubClientInterface } from '../src';
import type { AgentRuntime, IAgentRuntime } from '@elizaos/core';
import { Octokit } from '@octokit/rest';
import simpleGit from 'simple-git';
import type fs from 'fs';
import type fsPromises from 'fs/promises';

// Mock external dependencies
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(),
}));

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    clone: vi.fn(),
    pull: vi.fn(),
    checkout: vi.fn(),
  })),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as typeof fsPromises;
  return {
    ...actual,
    mkdir: vi.fn(),
    lstat: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof fs;
  return {
    ...actual,
    existsSync: vi.fn(),
    realpathSync: vi.fn(),
    lstatSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

describe('GitHubClient', () => {
  let mockRuntime: AgentRuntime;
  const mockConfig = {
    GITHUB_OWNER: 'testowner',
    GITHUB_REPO: 'testrepo',
    GITHUB_BRANCH: 'main',
    GITHUB_PATH: 'src',
    GITHUB_API_TOKEN: 'ghp_test123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime = {
      getSetting: vi.fn((key: string) => mockConfig[key as keyof typeof mockConfig]),
    } as unknown as AgentRuntime;
  });

  it('initializes with correct configuration', () => {
    const client = new GitHubClient(mockRuntime);
    expect(Octokit).toHaveBeenCalledWith({ auth: mockConfig.GITHUB_API_TOKEN });
  });

  describe('GitHubClientInterface', () => {
    it('has start and stop methods', () => {
      expect(GitHubClientInterface.start).toBeDefined();
      expect(GitHubClientInterface.stop).toBeDefined();
    });

    it('start method initializes client', async () => {
      const runtime = {
        getSetting: vi.fn((key: string) => mockConfig[key as keyof typeof mockConfig]),
      } as unknown as IAgentRuntime;

      await GitHubClientInterface.start(runtime);
      // Add more specific assertions based on what start should do
    });

    it('stop method cleans up resources', () => {
      const runtime = {} as IAgentRuntime;
      GitHubClientInterface.stop(runtime);
      // Add assertions for cleanup if needed
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../src/service';
import type { IAgentRuntime } from '@elizaos/core';

// Mock IAgentRuntime
const mockRuntime: Partial<IAgentRuntime> = {
  getSetting: vi.fn((key: string) => {
    const settings: Record<string, string> = {
      GITHUB_API_TOKEN: 'test_token',
      GITHUB_OWNER: 'test_owner',
      GITHUB_REPO: 'test_repo',
      GITHUB_BRANCH: 'main',
    };
    return settings[key] ?? null;
  }),
  agentId: 'test-agent-id' as never,
};

describe('GitHubService', () => {
  let service: GitHubService;

  beforeEach(() => {
    service = new GitHubService();
  });

  it('should have correct service name', () => {
    expect(GitHubService.serviceType).toBe('github');
  });

  it('should be creatable', () => {
    expect(service).toBeInstanceOf(GitHubService);
  });

  it('should not be started initially', () => {
    expect(service.isRunning).toBe(false);
  });
});


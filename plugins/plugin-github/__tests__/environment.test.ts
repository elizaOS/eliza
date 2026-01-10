import { describe, it, expect, vi } from 'vitest';
import { validateGithubConfig, githubEnvSchema } from '../src/environment';
import type { IAgentRuntime } from '@elizaos/core';

describe('GitHub Environment Configuration', () => {
  const mockRuntime: IAgentRuntime = {
    getSetting: vi.fn(),
  } as unknown as IAgentRuntime;

  it('validates correct GitHub configuration', async () => {
    const validConfig = {
      GITHUB_OWNER: 'testowner',
      GITHUB_REPO: 'testrepo',
      GITHUB_BRANCH: 'main',
      GITHUB_PATH: 'src',
      GITHUB_API_TOKEN: 'ghp_test123',
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => validConfig[key as keyof typeof validConfig]);

    const config = await validateGithubConfig(mockRuntime);
    expect(config).toEqual(validConfig);
  });

  it('throws error for missing configuration', async () => {
    const invalidConfig = {
      GITHUB_OWNER: '',
      GITHUB_REPO: '',
      GITHUB_BRANCH: '',
      GITHUB_PATH: '',
      GITHUB_API_TOKEN: '',
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => invalidConfig[key as keyof typeof invalidConfig]);

    await expect(validateGithubConfig(mockRuntime)).rejects.toThrow();
  });

  it('throws error for partial configuration', async () => {
    const partialConfig = {
      GITHUB_OWNER: 'testowner',
      GITHUB_REPO: 'testrepo',
      // Missing other required fields
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => partialConfig[key as keyof typeof partialConfig]);

    await expect(validateGithubConfig(mockRuntime)).rejects.toThrow();
  });
});

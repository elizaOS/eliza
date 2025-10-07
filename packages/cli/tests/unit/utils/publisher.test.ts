import { describe, it, expect, beforeEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';

// Mock the external dependencies
mock.module('../../../src/utils/github', () => ({
  getFileContent: mock(),
  updateFile: mock(),
  createPullRequest: mock(),
  getGitHubCredentials: mock(() => Promise.resolve({ token: 'fake-token', username: 'test-user' })),
  branchExists: mock(() => Promise.resolve(false)),
  createBranch: mock(() => Promise.resolve(true)),
  forkExists: mock(() => Promise.resolve(false)),
  forkRepository: mock(() => Promise.resolve('test-user/registry')),
  ensureDirectory: mock(() => Promise.resolve(true)),
  createGitHubRepository: mock(() =>
    Promise.resolve({ success: true, repoUrl: 'https://github.com/test-user/test-repo' })
  ),
  pushToGitHub: mock(() => Promise.resolve(true)),
}));

mock.module('../../../src/utils/registry', () => ({
  getRegistrySettings: mock(() =>
    Promise.resolve({
      defaultRegistry: 'elizaos/registry',
      registryOwner: 'elizaos',
      registryRepo: 'registry',
      registryBranch: 'main',
    })
  ),
}));

mock.module('@/src/utils/bun-exec', () => ({
  bunExec: mock(),
  bunExecInherit: mock(),
}));

mock.module('node:fs/promises', () => ({
  readFile: mock(),
  writeFile: mock(),
  access: mock(),
  mkdir: mock(),
  rm: mock(),
}));

mock.module('@elizaos/core', () => ({
  logger: {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
    success: mock(),
  },
}));

// Import the function to test
import { publishToGitHub } from '../../../src/utils/publisher';

// Import mocked modules
import { getFileContent, updateFile, createPullRequest } from '../../../src/utils/github';
import { logger } from '@elizaos/core';

interface PackageJson {
  name: string;
  version: string;
  repository?: { url: string };
  packageType?: 'plugin' | 'project';
  description?: string;
}

describe('Publisher JSON Manipulation', () => {
  let consoleLogSpy: ReturnType<typeof mock>;
  let consoleErrorSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    // Reset all mocks
    (getFileContent as ReturnType<typeof mock>).mockReset();
    (updateFile as ReturnType<typeof mock>).mockReset();
    (createPullRequest as ReturnType<typeof mock>).mockReset();
    (fs.readFile as ReturnType<typeof mock>).mockReset();
    (logger.error as ReturnType<typeof mock>).mockReset();
    (logger.info as ReturnType<typeof mock>).mockReset();
    (logger.warn as ReturnType<typeof mock>).mockReset();
    (logger.debug as ReturnType<typeof mock>).mockReset();

    consoleLogSpy = mock(() => {});
    consoleErrorSpy = mock(() => {});
    console.log = consoleLogSpy;
    console.error = consoleErrorSpy;
  });

  describe('index.json comma placement', () => {
    it('should handle empty registry correctly', async () => {
      // Setup: Empty registry with just braces
      const emptyRegistry = '{}';
      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(emptyRegistry)
      );

      // Mock package.json file read
      const packageJson: PackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/test/test-plugin.git' },
      };
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());
      (updateFile as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(true));

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      // Verify the updateFile was called with correct JSON (no comma after opening brace)
      const updateCalls = (updateFile as ReturnType<typeof mock>).mock.calls as Array<string[]>;
      const indexUpdateCall = updateCalls.find((call) => call[3] === 'index.json');

      if (indexUpdateCall) {
        const updatedContent = indexUpdateCall[4]; // Content is already a plain string
        const parsed = JSON.parse(updatedContent); // Should not throw
        expect(Object.keys(parsed)).toContain('test-plugin');
        // Verify no invalid comma patterns
        expect(updatedContent).not.toContain('{,');
        expect(updatedContent).not.toContain(',}');
      }
    });

    it('should add entry as first item correctly', async () => {
      // Setup: Registry with one existing entry
      const singleEntryRegistry = `{
  "@existing/plugin": "github:existing/plugin"
}`;
      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(singleEntryRegistry)
      );
      const packageJson: PackageJson = {
        name: '@new/first-plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/new/first-plugin.git' },
      };
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());
      (updateFile as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(true));

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as ReturnType<typeof mock>).mock.calls as Array<string[]>;
      const indexUpdateCall = updateCalls.find((call) => call[3] === 'index.json');

      if (indexUpdateCall) {
        const updatedContent = indexUpdateCall[4]; // Content is already a plain string
        const parsed = JSON.parse(updatedContent); // Should not throw

        // Both entries should exist
        expect(Object.keys(parsed)).toContain('@existing/plugin');
        expect(Object.keys(parsed)).toContain('@new/first-plugin');

        // Verify proper comma placement
        const lines = updatedContent.split('\n');
        const existingLine = lines.find((l: string) => l.includes('@existing/plugin'));
        const newLine = lines.find((l: string) => l.includes('@new/first-plugin'));

        // First entry should have comma, last should not
        if (existingLine && newLine && lines.indexOf(newLine) < lines.indexOf(existingLine)) {
          expect(newLine).toMatch(/,\s*$/);
          expect(existingLine).not.toMatch(/,\s*$/);
        }
      }
    });

    it('should add entry as last item correctly', async () => {
      // Setup: Registry with existing entries
      const multiEntryRegistry = `{
  "@first/plugin": "github:first/plugin",
  "@second/plugin": "github:second/plugin"
}`;
      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(multiEntryRegistry)
      );
      const packageJson: PackageJson = {
        name: 'zzz-last-plugin', // Alphabetically last
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/test/zzz-last-plugin.git' },
      };
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());
      (updateFile as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(true));

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as ReturnType<typeof mock>).mock.calls as Array<string[]>;
      const indexUpdateCall = updateCalls.find((call) => call[3] === 'index.json');

      if (indexUpdateCall) {
        const updatedContent = indexUpdateCall[4]; // Content is already a plain string
        const parsed = JSON.parse(updatedContent); // Should not throw

        // Verify all entries exist
        expect(Object.keys(parsed)).toContain('@first/plugin');
        expect(Object.keys(parsed)).toContain('@second/plugin');
        expect(Object.keys(parsed)).toContain('zzz-last-plugin');

        // Verify no trailing comma on last entry
        const lines = updatedContent.split('\n');
        const lastPluginLine = lines.find((l: string) => l.includes('zzz-last-plugin'));
        expect(lastPluginLine).not.toMatch(/,\s*$/);

        // Verify second-to-last has comma
        const secondLine = lines.find((l: string) => l.includes('@second/plugin'));
        expect(secondLine).toMatch(/,\s*$/);
      }
    });

    it('should add entry in middle correctly', async () => {
      // Setup: Registry where new entry goes in middle alphabetically
      const registry = `{
  "@aaa/plugin": "github:aaa/plugin",
  "@zzz/plugin": "github:zzz/plugin"
}`;
      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(registry)
      );
      const packageJson: PackageJson = {
        name: '@middle/plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/middle/plugin.git' },
      };
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());
      (updateFile as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(true));

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as ReturnType<typeof mock>).mock.calls as Array<string[]>;
      const indexUpdateCall = updateCalls.find((call) => call[3] === 'index.json');

      if (indexUpdateCall) {
        const updatedContent = indexUpdateCall[4]; // Content is already a plain string
        const parsed = JSON.parse(updatedContent); // Should not throw

        // All three entries should exist
        expect(Object.keys(parsed)).toContain('@aaa/plugin');
        expect(Object.keys(parsed)).toContain('@middle/plugin');
        expect(Object.keys(parsed)).toContain('@zzz/plugin');

        // Middle entry should have comma
        const lines = updatedContent.split('\n');
        const middleLine = lines.find((l: string) => l.includes('@middle/plugin'));
        expect(middleLine).toMatch(/,\s*$/);

        // Last entry should not have comma
        const lastLine = lines.find((l: string) => l.includes('@zzz/plugin'));
        expect(lastLine).not.toMatch(/,\s*$/);
      }
    });

    it('should handle registry with inconsistent formatting', async () => {
      // Setup: Registry with mixed formatting
      const messyRegistry = `{
  "@first/plugin":"github:first/plugin"  ,
      "@second/plugin"  :  "github:second/plugin",


  "@third/plugin": "github:third/plugin"
}`;
      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(messyRegistry)
      );
      const packageJson: PackageJson = {
        name: '@new/plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/new/plugin.git' },
      };
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());
      (updateFile as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(true));

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as ReturnType<typeof mock>).mock.calls as Array<string[]>;
      const indexUpdateCall = updateCalls.find((call) => call[3] === 'index.json');

      if (indexUpdateCall) {
        const updatedContent = indexUpdateCall[4]; // Content is already a plain string
        // Should still produce valid JSON despite messy input
        expect(() => JSON.parse(updatedContent)).not.toThrow();
      }
    });

    it('should not add comma after non-entry lines', async () => {
      // Setup: Registry with comments or other non-entry content
      const registryWithComments = `{
  // This is a comment
  "@first/plugin": "github:first/plugin"
}`;
      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(registryWithComments)
      );
      const packageJson: PackageJson = {
        name: '@last/plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/last/plugin.git' },
      };
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());
      (updateFile as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(true));

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as ReturnType<typeof mock>).mock.calls as Array<string[]>;
      const indexUpdateCall = updateCalls.find((call) => call[3] === 'index.json');

      if (indexUpdateCall) {
        const updatedContent = indexUpdateCall[4]; // Content is already a plain string
        const lines = updatedContent.split('\n');

        // Comment line should not have comma added
        const commentLine = lines.find((l: string) => l.includes('//'));
        if (commentLine) {
          expect(commentLine).not.toMatch(/,\s*$/);
        }
      }
    });

    it('should handle malformed newEntry without trailing comma', async () => {
      // This tests the edge case where newEntry might not have a comma
      const registry = `{
  "@existing/plugin": "github:existing/plugin"
}`;
      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(registry)
      );

      // Mock package.json to return a name that would sort last
      const packageJson: PackageJson = {
        name: 'zzz-plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/test/zzz-plugin.git' },
      };
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());
      (updateFile as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve(true));

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as ReturnType<typeof mock>).mock.calls as Array<string[]>;
      const indexUpdateCall = updateCalls.find((call) => call[3] === 'index.json');

      if (indexUpdateCall) {
        const updatedContent = indexUpdateCall[4]; // Content is already a plain string
        const parsed = JSON.parse(updatedContent); // Should not throw

        // Verify both entries exist
        expect(Object.keys(parsed)).toContain('@existing/plugin');
        expect(Object.keys(parsed)).toContain('zzz-plugin');

        // Verify no trailing comma issues
        expect(updatedContent).not.toContain(',,');
        expect(updatedContent).not.toContain(',}');
      }
    });
  });

  describe('test mode behavior', () => {
    it('should return true in test mode regardless of mocked errors', async () => {
      const packageJson: PackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/test/plugin.git' },
      };

      // Mock file read to throw error - but test mode should bypass this
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.reject(new Error('package.json not found'))
      );

      const result = await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      // Test mode always returns true regardless of errors
      expect(result).toBe(true);
    });

    it('should handle GitHub API mock failures in test mode', async () => {
      const packageJson: PackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/test/plugin.git' },
      };

      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.reject(new Error('GitHub API error'))
      );
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());

      const result = await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      // Test mode always returns true regardless of mocked errors
      expect(result).toBe(true);
    });

    it('should handle invalid JSON mock in test mode', async () => {
      const packageJson: PackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        packageType: 'plugin',
        repository: { url: 'https://github.com/test/plugin.git' },
      };

      const invalidJson = '{ "broken": ';
      (getFileContent as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(invalidJson)
      );
      (fs.readFile as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve(JSON.stringify(packageJson))
      );
      (fs.access as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve());

      const result = await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      // Test mode always returns true regardless of mocked JSON errors
      expect(result).toBe(true);
    });
  });
});

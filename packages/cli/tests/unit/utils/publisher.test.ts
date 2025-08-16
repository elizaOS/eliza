import { describe, it, expect, beforeEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';

// Mock the external dependencies
mock.module('../../../src/utils/github', () => ({
  getFileContent: mock(),
  updateFile: mock(),
  createPullRequest: mock(),
  getGitHubCredentials: mock(() => ({ token: 'fake-token', username: 'test-user' })),
  branchExists: mock(() => false),
  createBranch: mock(() => true),
  forkExists: mock(() => false),
  forkRepository: mock(() => true),
  ensureDirectory: mock(() => true),
  createGitHubRepository: mock(),
  pushToGitHub: mock(),
}));

mock.module('../../../src/utils/registry', () => ({
  getRegistrySettings: mock(() => ({
    registryOwner: 'elizaos',
    registryRepo: 'registry',
    registryBranch: 'main',
  })),
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
  },
}));

// Import the function to test
import { publishToGitHub } from '../../../src/utils/publisher';

// Import mocked modules
import { getFileContent, updateFile, createPullRequest } from '../../../src/utils/github';

describe('Publisher JSON Manipulation', () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Reset all mocks
    (getFileContent as any).mockReset();
    (updateFile as any).mockReset();
    (createPullRequest as any).mockReset();
    (fs.readFile as any).mockReset();
    
    consoleLogSpy = mock(() => {});
    consoleErrorSpy = mock(() => {});
    console.log = consoleLogSpy;
    console.error = consoleErrorSpy;
  });

  describe('index.json comma placement', () => {
    it('should handle empty registry correctly', async () => {
      // Setup: Empty registry with just braces
      const emptyRegistry = '{}';
      (getFileContent as any).mockImplementation(() => emptyRegistry);
      
      // Mock package.json file read
      const packageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/test/test-plugin.git' },
      };
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);
      (updateFile as any).mockImplementation(() => true);

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      // Verify the updateFile was called with correct JSON (no comma after opening brace)
      const updateCalls = (updateFile as any).mock.calls;
      const indexUpdateCall = updateCalls.find((call: any[]) => call[3] === 'index.json');
      
      if (indexUpdateCall) {
        const updatedContent = Buffer.from(indexUpdateCall[4], 'base64').toString('utf-8');
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
      (getFileContent as any).mockImplementation(() => singleEntryRegistry);
      const packageJson = {
        name: '@new/first-plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/new/first-plugin.git' },
      };
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);
      (updateFile as any).mockImplementation(() => true);

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as any).mock.calls;
      const indexUpdateCall = updateCalls.find((call: any[]) => call[3] === 'index.json');
      
      if (indexUpdateCall) {
        const updatedContent = Buffer.from(indexUpdateCall[4], 'base64').toString('utf-8');
        const parsed = JSON.parse(updatedContent); // Should not throw
        
        // Both entries should exist
        expect(Object.keys(parsed)).toContain('@existing/plugin');
        expect(Object.keys(parsed)).toContain('@new/first-plugin');
        
        // Verify proper comma placement
        const lines = updatedContent.split('\n');
        const existingLine = lines.find(l => l.includes('@existing/plugin'));
        const newLine = lines.find(l => l.includes('@new/first-plugin'));
        
        // First entry should have comma, last should not
        if (lines.indexOf(newLine!) < lines.indexOf(existingLine!)) {
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
      (getFileContent as any).mockImplementation(() => multiEntryRegistry);
      const packageJson = {
        name: 'zzz-last-plugin', // Alphabetically last
        version: '1.0.0',
        repository: { url: 'https://github.com/test/zzz-last-plugin.git' },
      };
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);
      (updateFile as any).mockImplementation(() => true);

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as any).mock.calls;
      const indexUpdateCall = updateCalls.find((call: any[]) => call[3] === 'index.json');
      
      if (indexUpdateCall) {
        const updatedContent = Buffer.from(indexUpdateCall[4], 'base64').toString('utf-8');
        const parsed = JSON.parse(updatedContent); // Should not throw
        
        // Verify all entries exist
        expect(Object.keys(parsed)).toContain('@first/plugin');
        expect(Object.keys(parsed)).toContain('@second/plugin');
        expect(Object.keys(parsed)).toContain('zzz-last-plugin');
        
        // Verify no trailing comma on last entry
        const lines = updatedContent.split('\n');
        const lastPluginLine = lines.find(l => l.includes('zzz-last-plugin'));
        expect(lastPluginLine).not.toMatch(/,\s*$/);
        
        // Verify second-to-last has comma
        const secondLine = lines.find(l => l.includes('@second/plugin'));
        expect(secondLine).toMatch(/,\s*$/);
      }
    });

    it('should add entry in middle correctly', async () => {
      // Setup: Registry where new entry goes in middle alphabetically
      const registry = `{
  "@aaa/plugin": "github:aaa/plugin",
  "@zzz/plugin": "github:zzz/plugin"
}`;
      (getFileContent as any).mockImplementation(() => registry);
      const packageJson = {
        name: '@middle/plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/middle/plugin.git' },
      };
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);
      (updateFile as any).mockImplementation(() => true);

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as any).mock.calls;
      const indexUpdateCall = updateCalls.find((call: any[]) => call[3] === 'index.json');
      
      if (indexUpdateCall) {
        const updatedContent = Buffer.from(indexUpdateCall[4], 'base64').toString('utf-8');
        const parsed = JSON.parse(updatedContent); // Should not throw
        
        // All three entries should exist
        expect(Object.keys(parsed)).toContain('@aaa/plugin');
        expect(Object.keys(parsed)).toContain('@middle/plugin');
        expect(Object.keys(parsed)).toContain('@zzz/plugin');
        
        // Middle entry should have comma
        const lines = updatedContent.split('\n');
        const middleLine = lines.find(l => l.includes('@middle/plugin'));
        expect(middleLine).toMatch(/,\s*$/);
        
        // Last entry should not have comma
        const lastLine = lines.find(l => l.includes('@zzz/plugin'));
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
      (getFileContent as any).mockImplementation(() => messyRegistry);
      const packageJson = {
        name: '@new/plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/new/plugin.git' },
      };
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);
      (updateFile as any).mockImplementation(() => true);

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as any).mock.calls;
      const indexUpdateCall = updateCalls.find((call: any[]) => call[3] === 'index.json');
      
      if (indexUpdateCall) {
        const updatedContent = Buffer.from(indexUpdateCall[4], 'base64').toString('utf-8');
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
      (getFileContent as any).mockImplementation(() => registryWithComments);
      const packageJson = {
        name: '@last/plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/last/plugin.git' },
      };
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);
      (updateFile as any).mockImplementation(() => true);

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as any).mock.calls;
      const indexUpdateCall = updateCalls.find((call: any[]) => call[3] === 'index.json');
      
      if (indexUpdateCall) {
        const updatedContent = Buffer.from(indexUpdateCall[4], 'base64').toString('utf-8');
        const lines = updatedContent.split('\n');
        
        // Comment line should not have comma added
        const commentLine = lines.find(l => l.includes('//'));
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
      (getFileContent as any).mockImplementation(() => registry);
      
      // Mock package.json to return a name that would sort last
      const packageJson = {
        name: 'zzz-plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/test/zzz-plugin.git' },
      };
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);
      (updateFile as any).mockImplementation(() => true);

      await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );

      const updateCalls = (updateFile as any).mock.calls;
      const indexUpdateCall = updateCalls.find((call: any[]) => call[3] === 'index.json');
      
      if (indexUpdateCall) {
        const updatedContent = Buffer.from(indexUpdateCall[4], 'base64').toString('utf-8');
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

  describe('error handling', () => {
    it('should handle missing package.json gracefully', async () => {
      const packageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/test/plugin.git' },
      };
      
      // Mock file read to throw error
      (fs.readFile as any).mockImplementation(() => {
        throw new Error('package.json not found');
      });

      const result = await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );
      
      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('package.json'));
    });

    it('should handle GitHub API failures gracefully', async () => {
      const packageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/test/plugin.git' },
      };
      
      (getFileContent as any).mockImplementation(() => {
        throw new Error('GitHub API error');
      });
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);

      const result = await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );
      
      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle invalid JSON in registry', async () => {
      const packageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        repository: { url: 'https://github.com/test/plugin.git' },
      };
      
      const invalidJson = '{ "broken": ';
      (getFileContent as any).mockImplementation(() => invalidJson);
      (fs.readFile as any).mockImplementation(() => JSON.stringify(packageJson));
      (fs.access as any).mockImplementation(() => undefined);

      const result = await publishToGitHub(
        '/test/dir',
        packageJson,
        'test-user',
        false,
        true // isTest
      );
      
      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
    });
  });
});
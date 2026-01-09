import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { Agent } from '@elizaos/core';

// Store original console.log
const originalConsoleLog = console.log;
let consoleOutput: string[] = [];

// Mock console.log to capture output
const captureConsole = () => {
  consoleOutput = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(' '));
  };
};

const restoreConsole = () => {
  console.log = originalConsoleLog;
};

// Helper to check if any output contains a string
const outputContains = (searchStr: string): boolean => {
  return consoleOutput.some((line) => line.includes(searchStr));
};

// Helper to check if any output matches exactly
const outputIncludes = (searchStr: string): boolean => {
  return consoleOutput.includes(searchStr);
};

describe('helpers', () => {
  // Import helpers dynamically after mocking
  let displayAgent: (data: Partial<Agent>, title?: string) => void;
  let logHeader: (title: string) => void;

  beforeEach(async () => {
    captureConsole();
    // Dynamic import to ensure fresh module
    const helpers = await import('../../../src/utils/helpers');
    displayAgent = helpers.displayAgent;
    logHeader = helpers.logHeader;
  });

  afterEach(() => {
    restoreConsole();
    consoleOutput = [];
  });

  describe('displayAgent', () => {
    it('should display basic agent info', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        username: 'test_agent',
      };

      displayAgent(agent);

      expect(outputContains('Name: Test Agent')).toBe(true);
      expect(outputContains('Username: test_agent')).toBe(true);
    });

    it('should generate username from name if not provided', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent Name',
      };

      displayAgent(agent);

      expect(outputContains('Username: test_agent_name')).toBe(true);
    });

    it('should display bio array', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        bio: ['Bio line 1', 'Bio line 2'],
      };

      displayAgent(agent);

      expect(outputContains('Bio:')).toBe(true);
      expect(outputContains('Bio line 1')).toBe(true);
      expect(outputContains('Bio line 2')).toBe(true);
    });

    it('should display bio string as array', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        bio: 'Single bio line' as unknown as string[],
      };

      displayAgent(agent);

      expect(outputContains('Bio:')).toBe(true);
      expect(outputContains('Single bio line')).toBe(true);
    });

    it('should display all array sections', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        adjectives: ['smart', 'funny'],
        topics: ['AI', 'Tech'],
        plugins: ['plugin1', 'plugin2'],
        postExamples: ['Example 1', 'Example 2'],
      };

      displayAgent(agent);

      expect(outputContains('Adjectives:')).toBe(true);
      expect(outputContains('smart')).toBe(true);
      expect(outputContains('funny')).toBe(true);

      expect(outputContains('Topics:')).toBe(true);
      expect(outputContains('AI')).toBe(true);
      expect(outputContains('Tech')).toBe(true);

      expect(outputContains('Plugins:')).toBe(true);
      expect(outputContains('plugin1')).toBe(true);
      expect(outputContains('plugin2')).toBe(true);

      expect(outputContains('Post Examples:')).toBe(true);
      expect(outputContains('Example 1')).toBe(true);
      expect(outputContains('Example 2')).toBe(true);
    });

    it('should display style sections', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        style: {
          all: ['General style 1', 'General style 2'],
          chat: ['Chat style 1'],
          post: ['Post style 1'],
        },
      };

      displayAgent(agent);

      expect(outputContains('General Style:')).toBe(true);
      expect(outputContains('General style 1')).toBe(true);
      expect(outputContains('General style 2')).toBe(true);
      expect(outputContains('Chat Style:')).toBe(true);
      expect(outputContains('Chat style 1')).toBe(true);
      expect(outputContains('Post Style:')).toBe(true);
      expect(outputContains('Post style 1')).toBe(true);
    });

    it('should display message examples', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        messageExamples: [
          [
            { name: '{{name1}}', content: { text: 'Hello' } },
            { name: 'Agent', content: { text: 'Hi there' } },
          ],
        ],
      };

      displayAgent(agent);

      expect(outputContains('Message Examples:')).toBe(true);
      expect(outputContains('Anon: Hello')).toBe(true);
      expect(outputContains('Agent: Hi there')).toBe(true);
    });

    it('should use custom title', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
      };

      displayAgent(agent, 'Custom Title');

      expect(outputContains('Custom Title')).toBe(true);
    });

    it('should handle empty sections gracefully', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        bio: [],
        topics: undefined,
        adjectives: [],
      };

      displayAgent(agent);

      // Empty sections should not be displayed
      // Bio: should not appear because bio is empty array
      const bioLines = consoleOutput.filter(
        (line) => line.includes('Bio:') && !line.includes('Name:')
      );
      expect(bioLines.length).toBe(0);

      // Topics: should not appear because it's undefined
      expect(outputContains('Topics:')).toBe(false);

      // Adjectives: should not appear because it's empty
      expect(outputContains('Adjectives:')).toBe(false);
    });
  });

  describe('logHeader', () => {
    it('should log header with borders', () => {
      logHeader('Test Header');

      expect(outputContains('┌')).toBe(true);
      expect(outputContains('┐')).toBe(true);
      expect(outputContains('└')).toBe(true);
      expect(outputContains('┘')).toBe(true);
      expect(outputContains('Test Header')).toBe(true);
    });

    it('should add padding around title', () => {
      logHeader('Short');

      expect(outputContains('===')).toBe(true);
      expect(outputContains('Short')).toBe(true);
    });

    it('should create border matching title length', () => {
      logHeader('A Very Long Title That Should Have A Long Border');

      // Check that output contains horizontal border characters
      const borderLines = consoleOutput.filter((line) => line.includes('─'));
      expect(borderLines.length).toBeGreaterThan(0);
    });

    it('should add newline before header', () => {
      logHeader('Test');

      // First output should start with newline
      expect(consoleOutput.length).toBeGreaterThan(0);
      expect(consoleOutput[0].startsWith('\n')).toBe(true);
    });
  });
});

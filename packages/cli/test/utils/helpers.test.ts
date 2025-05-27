import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@elizaos/core', () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('yoctocolors', () => ({
  default: {
    cyan: vi.fn((text) => `CYAN:${text}`),
    green: vi.fn((text) => `GREEN:${text}`),
  },
}));

import { displayAgent, logHeader } from '../../src/utils/helpers';
import colors from 'yoctocolors';
import type { Agent, MessageExample } from '@elizaos/core';

describe('helpers', () => {
  // Mock console.log to capture output
  const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('displayAgent', () => {
    it('should display basic agent information', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        username: 'test_agent',
      };

      displayAgent(agent);

      expect(mockConsoleLog).toHaveBeenCalledWith('Name: TestAgent');
      expect(mockConsoleLog).toHaveBeenCalledWith('Username: test_agent');
    });

    it('should generate username from name when username is not provided', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent Name',
      };

      displayAgent(agent);

      expect(mockConsoleLog).toHaveBeenCalledWith('Name: Test Agent Name');
      expect(mockConsoleLog).toHaveBeenCalledWith('Username: test_agent_name');
    });

    it('should display bio as array', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        bio: ['First bio line', 'Second bio line'],
      };

      displayAgent(agent);

      expect(colors.cyan).toHaveBeenCalledWith('Bio:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  First bio line');
      expect(mockConsoleLog).toHaveBeenCalledWith('  Second bio line');
    });

    it('should display bio as string', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        bio: 'Single bio string',
      };

      displayAgent(agent);

      expect(colors.cyan).toHaveBeenCalledWith('Bio:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  Single bio string');
    });

    it('should display adjectives section', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        adjectives: ['smart', 'helpful', 'friendly'],
      };

      displayAgent(agent);

      expect(colors.cyan).toHaveBeenCalledWith('Adjectives:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  smart');
      expect(mockConsoleLog).toHaveBeenCalledWith('  helpful');
      expect(mockConsoleLog).toHaveBeenCalledWith('  friendly');
    });

    it('should display topics section', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        topics: ['technology', 'science', 'programming'],
      };

      displayAgent(agent);

      expect(colors.cyan).toHaveBeenCalledWith('Topics:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  technology');
      expect(mockConsoleLog).toHaveBeenCalledWith('  science');
      expect(mockConsoleLog).toHaveBeenCalledWith('  programming');
    });

    it('should display plugins section', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        plugins: ['plugin1', 'plugin2'],
      };

      displayAgent(agent);

      expect(colors.cyan).toHaveBeenCalledWith('Plugins:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  plugin1');
      expect(mockConsoleLog).toHaveBeenCalledWith('  plugin2');
    });

    it('should display style sections when style is provided', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        style: {
          all: ['general style 1', 'general style 2'],
          chat: ['chat style 1'],
          post: ['post style 1', 'post style 2'],
        },
      };

      displayAgent(agent);

      expect(colors.cyan).toHaveBeenCalledWith('General Style:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  general style 1');
      expect(mockConsoleLog).toHaveBeenCalledWith('  general style 2');

      expect(colors.cyan).toHaveBeenCalledWith('Chat Style:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  chat style 1');

      expect(colors.cyan).toHaveBeenCalledWith('Post Style:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  post style 1');
      expect(mockConsoleLog).toHaveBeenCalledWith('  post style 2');
    });

    it('should display post examples', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        postExamples: ['Example post 1', 'Example post 2'],
      };

      displayAgent(agent);

      expect(colors.cyan).toHaveBeenCalledWith('Post Examples:');
      expect(mockConsoleLog).toHaveBeenCalledWith('  Example post 1');
      expect(mockConsoleLog).toHaveBeenCalledWith('  Example post 2');
    });

    it('should display message examples with conversations', () => {
      const messageExamples: MessageExample[][] = [
        [
          { name: '{{name1}}', content: { text: 'Hello there!' } },
          { name: 'TestAgent', content: { text: 'Hi! How can I help you?' } },
        ],
        [
          { name: '{{name1}}', content: { text: 'What is AI?' } },
          { name: 'TestAgent', content: { text: 'AI stands for Artificial Intelligence.' } },
        ],
      ];

      const agent: Partial<Agent> = {
        name: 'TestAgent',
        messageExamples,
      };

      displayAgent(agent);

      expect(colors.cyan).toHaveBeenCalledWith('Message Examples:');

      // Check conversation formatting
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Conversation 1:'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Anon: Hello there!'));
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('TestAgent: Hi! How can I help you?')
      );

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Conversation 2:'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Anon: What is AI?'));
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('TestAgent: AI stands for Artificial Intelligence.')
      );
    });

    it('should not display empty sections', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
        adjectives: [],
        topics: undefined,
        plugins: [],
      };

      displayAgent(agent);

      expect(colors.cyan).not.toHaveBeenCalledWith('Adjectives:');
      expect(colors.cyan).not.toHaveBeenCalledWith('Topics:');
      expect(colors.cyan).not.toHaveBeenCalledWith('Plugins:');
    });

    it('should use custom title when provided', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
      };

      displayAgent(agent, 'Custom Title');

      expect(colors.green).toHaveBeenCalledWith('Custom Title');
    });

    it('should use default title when not provided', () => {
      const agent: Partial<Agent> = {
        name: 'TestAgent',
      };

      displayAgent(agent);

      expect(colors.green).toHaveBeenCalledWith('Agent Review');
    });
  });

  describe('logHeader', () => {
    it('should display header with border and title', () => {
      logHeader('Test Header');

      // Check that colors.green was called with border characters
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('┌'));
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('─'));
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('┐'));
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('└'));
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('┘'));

      // Check that the title is colored
      expect(colors.green).toHaveBeenCalledWith('Test Header');

      // Check that console.log was called with the formatted output
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('GREEN:┌'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('GREEN:Test Header'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('GREEN:└'));
    });

    it('should handle empty title', () => {
      logHeader('');

      expect(colors.green).toHaveBeenCalledWith('');
      expect(mockConsoleLog).toHaveBeenCalledTimes(1); // Single call with multi-line string
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('GREEN:┌'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('GREEN:└'));
    });

    it('should handle long title', () => {
      const longTitle = 'This is a very long title that should still be formatted correctly';

      logHeader(longTitle);

      expect(colors.green).toHaveBeenCalledWith(longTitle);
      expect(mockConsoleLog).toHaveBeenCalledTimes(1); // Single call with multi-line string
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('GREEN:┌'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('GREEN:└'));
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { displayAgent, logHeader } from '../../../src/utils/helpers';
import type { Agent } from '@elizaos/core';
import colors from 'yoctocolors';

// Mock dependencies
vi.mock('@elizaos/core', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('yoctocolors', () => ({
  default: {
    green: vi.fn((text) => `[green]${text}[/green]`),
    cyan: vi.fn((text) => `[cyan]${text}[/cyan]`)
  }
}));

// Mock console
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

describe('helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('displayAgent', () => {
    it('should display basic agent info', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        username: 'test_agent'
      };
      
      displayAgent(agent);
      
      expect(consoleSpy).toHaveBeenCalledWith('Name: Test Agent');
      expect(consoleSpy).toHaveBeenCalledWith('Username: test_agent');
    });

    it('should generate username from name if not provided', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent Name'
      };
      
      displayAgent(agent);
      
      expect(consoleSpy).toHaveBeenCalledWith('Username: test_agent_name');
    });

    it('should display bio array', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        bio: ['Bio line 1', 'Bio line 2']
      };
      
      displayAgent(agent);
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Bio:'));
      expect(consoleSpy).toHaveBeenCalledWith('  Bio line 1');
      expect(consoleSpy).toHaveBeenCalledWith('  Bio line 2');
    });

    it('should display bio string as array', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        bio: 'Single bio line' as any
      };
      
      displayAgent(agent);
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Bio:'));
      expect(consoleSpy).toHaveBeenCalledWith('  Single bio line');
    });

    it('should display all array sections', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        adjectives: ['smart', 'funny'],
        topics: ['AI', 'Tech'],
        plugins: ['plugin1', 'plugin2'],
        postExamples: ['Example 1', 'Example 2']
      };
      
      displayAgent(agent);
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Adjectives:'));
      expect(consoleSpy).toHaveBeenCalledWith('  smart');
      expect(consoleSpy).toHaveBeenCalledWith('  funny');
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Topics:'));
      expect(consoleSpy).toHaveBeenCalledWith('  AI');
      expect(consoleSpy).toHaveBeenCalledWith('  Tech');
    });

    it('should display style sections', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        style: {
          all: ['General style 1', 'General style 2'],
          chat: ['Chat style 1'],
          post: ['Post style 1']
        }
      };
      
      displayAgent(agent);
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('General Style:'));
      expect(consoleSpy).toHaveBeenCalledWith('  General style 1');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Chat Style:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Post Style:'));
    });

    it('should display message examples', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        messageExamples: [
          [
            { name: '{{name1}}', content: { text: 'Hello' } },
            { name: 'Agent', content: { text: 'Hi there' } }
          ]
        ]
      };
      
      displayAgent(agent);
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Message Examples:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Anon: Hello'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: Hi there'));
    });

    it('should use custom title', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent'
      };
      
      displayAgent(agent, 'Custom Title');
      
      // logHeader should be called with custom title
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Custom Title'));
    });

    it('should handle empty sections gracefully', () => {
      const agent: Partial<Agent> = {
        name: 'Test Agent',
        bio: [],
        topics: undefined,
        adjectives: []
      };
      
      displayAgent(agent);
      
      // Should not display empty sections
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Bio:'));
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Topics:'));
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Adjectives:'));
    });
  });

  describe('logHeader', () => {
    it('should log header with borders', () => {
      logHeader('Test Header');
      
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('┌'));
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('┐'));
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('└'));
      expect(colors.green).toHaveBeenCalledWith(expect.stringContaining('┘'));
      expect(colors.green).toHaveBeenCalledWith('Test Header');
    });

    it('should add padding around title', () => {
      logHeader('Short');
      
      // Should be called with padded title
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('  === '));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(' ===  '));
    });

    it('should create border matching title length', () => {
      logHeader('A Very Long Title That Should Have A Long Border');
      
      // Check that green was called with border characters
      const greenCalls = vi.mocked(colors.green).mock.calls;
      const borderCalls = greenCalls.filter(call => 
        call[0].includes('─')
      );
      
      expect(borderCalls.length).toBeGreaterThan(0);
    });

    it('should add newline before header', () => {
      logHeader('Test');
      
      const calls = consoleSpy.mock.calls;
      expect(calls.some(call => call[0].startsWith('\n'))).toBe(true);
    });
  });
}); 
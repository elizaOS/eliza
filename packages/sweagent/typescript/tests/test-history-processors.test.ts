/**
 * History processor tests converted from test_history_processors.py
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { LastNObservations, TagToolCallObservations } from '../src/agent/history-processors';
import { History } from '../src/types';

describe('History Processors', () => {
  let testHistory: History;

  beforeEach(() => {
    // Create a mock history similar to Python test
    testHistory = [
      {
        role: 'system',
        content: 'You are a helpful assistant.',
        messageType: 'thought' as const,
      },
      {
        role: 'user',
        content: 'Instance template content',
        messageType: 'thought' as const,
      },
      {
        role: 'assistant',
        content: 'I will help you.',
        messageType: 'action' as const,
        action: 'ls',
      },
      {
        role: 'user',
        content: 'file1.txt file2.txt',
        messageType: 'observation' as const,
      },
      {
        role: 'assistant',
        content: 'Let me edit a file.',
        messageType: 'action' as const,
        action: 'edit file1.txt',
      },
      {
        role: 'user',
        content: 'File edited successfully',
        messageType: 'observation' as const,
      },
      {
        role: 'assistant',
        content: 'Now checking the file.',
        messageType: 'action' as const,
        action: 'cat file1.txt',
      },
      {
        role: 'user',
        content: 'Content of file1.txt',
        messageType: 'observation' as const,
      },
      {
        role: 'assistant',
        content: 'Let me edit another file.',
        messageType: 'action' as const,
        action: 'edit file2.txt',
      },
      {
        role: 'user',
        content: 'File edited successfully',
        messageType: 'observation' as const,
      },
    ];
  });

  describe('LastNObservations', () => {
    it('should keep last N observations', () => {
      const processor = new LastNObservations({ n: 3 });
      const newHistory = processor.process(testHistory);

      // Count how many observations were elided
      const elidedCount = newHistory.filter(
        (entry) => entry.content && entry.content.toString().includes('Old environment output'),
      ).length;

      // We have 5 observations total, keeping 3 + 1 (instance template), so 1 should be elided
      const totalObservations = testHistory.filter((entry) => entry.messageType === 'observation').length;
      const expectedElided = Math.max(0, totalObservations - 3 - 1); // -1 for instance template

      expect(elidedCount).toBe(expectedElided);
    });

    it('should keep instance template', () => {
      const processor = new LastNObservations({ n: 2 });
      const newHistory = processor.process(testHistory);

      // Instance template (second item) should be kept
      expect(newHistory[1].content).toBe('Instance template content');
    });

    it('should handle history with fewer observations than N', () => {
      const smallHistory: History = [
        {
          role: 'system',
          content: 'System message',
          messageType: 'thought' as const,
        },
        {
          role: 'user',
          content: 'User message',
          messageType: 'observation' as const,
        },
      ];

      const processor = new LastNObservations({ n: 5 });
      const newHistory = processor.process(smallHistory);

      // No observations should be elided
      const elidedCount = newHistory.filter(
        (entry) => entry.content && entry.content.toString().includes('Old environment output'),
      ).length;
      expect(elidedCount).toBe(0);
    });
  });

  describe('TagToolCallObservations', () => {
    it('should add tags to edit actions', () => {
      const processor = new TagToolCallObservations({
        tags: new Set(['test']),
        functionNames: new Set(['edit']),
      });

      const newHistory = processor.process(testHistory);

      // Check that edit actions have tags
      newHistory.forEach((entry) => {
        if (entry.action && entry.action.startsWith('edit ')) {
          expect(entry.tags).toEqual(['test']);
        }
      });
    });

    it('should not add tags to non-matching actions', () => {
      const processor = new TagToolCallObservations({
        tags: new Set(['test']),
        functionNames: new Set(['edit']),
      });

      const newHistory = processor.process(testHistory);

      // Check that non-edit actions don't have tags
      newHistory.forEach((entry) => {
        if (entry.action && !entry.action.startsWith('edit ')) {
          expect(entry.tags).toBeUndefined();
        }
      });
    });

    it('should handle multiple tags and function names', () => {
      const processor = new TagToolCallObservations({
        tags: new Set(['tag1', 'tag2']),
        functionNames: new Set(['edit', 'cat']),
      });

      const newHistory = processor.process(testHistory);

      // Check that both edit and cat actions have tags
      newHistory.forEach((entry) => {
        if (entry.action && (entry.action.startsWith('edit ') || entry.action.startsWith('cat '))) {
          expect(entry.tags).toContain('tag1');
          expect(entry.tags).toContain('tag2');
        }
      });
    });

    it('should preserve existing tags', () => {
      const historyWithTags: History = [
        {
          role: 'assistant',
          content: 'Editing',
          messageType: 'action' as const,
          action: 'edit file.txt',
          tags: ['existing'],
        },
      ];

      const processor = new TagToolCallObservations({
        tags: new Set(['new']),
        functionNames: new Set(['edit']),
      });

      const newHistory = processor.process(historyWithTags);

      // Should have both existing and new tags
      expect(newHistory[0].tags).toContain('existing');
      expect(newHistory[0].tags).toContain('new');
    });
  });

  describe('Multiple processors', () => {
    it('should chain processors correctly', () => {
      const lastNProcessor = new LastNObservations({ n: 2 });
      const tagProcessor = new TagToolCallObservations({
        tags: new Set(['processed']),
        functionNames: new Set(['edit']),
      });

      // Apply processors in sequence
      let processedHistory = lastNProcessor.process(testHistory);
      processedHistory = tagProcessor.process(processedHistory);

      // Check that both processors were applied
      const elidedCount = processedHistory.filter(
        (entry) => entry.content && entry.content.toString().includes('Old environment output'),
      ).length;
      expect(elidedCount).toBeGreaterThan(0);

      const taggedEdits = processedHistory.filter(
        (entry) => entry.action && entry.action.startsWith('edit ') && entry.tags?.includes('processed'),
      );
      expect(taggedEdits.length).toBeGreaterThan(0);
    });
  });
});

import { describe, it, expect } from 'bun:test';

// Mock the types and runtime for testing
type Content = {
  text?: string;
  actions?: unknown[];
  providers?: unknown[];
  simple?: boolean;
};

// Helper function to simulate the ambiguity handling logic
function handleAmbiguity(responseContent: Content): Content {
  // --- LLM IGNORE/REPLY ambiguity handling ---
  // Sometimes the LLM outputs actions like ["REPLY", "IGNORE"], which breaks isSimple detection
  // and triggers unnecessary large LLM calls. We clarify intent here:
  // - If IGNORE is present with other actions:
  //    - If text is empty, we assume the LLM intended to IGNORE and drop all other actions.
  //    - If text is present, we assume the LLM intended to REPLY and remove IGNORE from actions.
  // This ensures consistent, clear behavior and preserves reply speed optimizations.
  if (responseContent.actions && responseContent.actions.length > 1) {
    // Helper function to safely check if an action is IGNORE
    const isIgnoreAction = (action: unknown): boolean => {
      return typeof action === 'string' && action.toUpperCase() === 'IGNORE';
    };

    // Check if any action is IGNORE
    const hasIgnoreAction = responseContent.actions.some(isIgnoreAction);

    if (hasIgnoreAction) {
      if (!responseContent.text || responseContent.text.trim() === '') {
        // No text, truly meant to IGNORE
        responseContent.actions = ['IGNORE'];
      } else {
        // Text present, LLM intended to reply, remove IGNORE
        const filteredActions = responseContent.actions.filter((action) => !isIgnoreAction(action));

        // Ensure we don't end up with an empty actions array when text is present
        // If all actions were IGNORE, default to REPLY
        if (filteredActions.length === 0) {
          responseContent.actions = ['REPLY'];
        } else {
          responseContent.actions = filteredActions;
        }
      }
    }
  }

  // Automatically determine if response is simple based on providers and actions
  // Simple = REPLY action with no providers used
  const isSimple =
    responseContent.actions?.length === 1 &&
    typeof responseContent.actions[0] === 'string' &&
    responseContent.actions[0].toUpperCase() === 'REPLY' &&
    (!responseContent.providers || responseContent.providers.length === 0);

  responseContent.simple = isSimple;

  return responseContent;
}

describe('LLM Ambiguity Handling', () => {
  describe('Bug 1: Empty Actions Array Fix', () => {
    it('should handle multiple IGNORE actions with text present', () => {
      const responseContent: Content = {
        text: 'Hello world',
        actions: ['IGNORE', 'IGNORE'],
      };

      const result = handleAmbiguity(responseContent);

      // Should default to REPLY when all actions were IGNORE but text is present
      expect(result.actions).toEqual(['REPLY']);
      expect(result.simple).toBe(true);
    });

    it('should handle mixed actions with IGNORE and text present', () => {
      const responseContent: Content = {
        text: 'Hello world',
        actions: ['REPLY', 'IGNORE', 'SEND_MESSAGE'],
      };

      const result = handleAmbiguity(responseContent);

      // Should remove IGNORE but keep other actions
      expect(result.actions).toEqual(['REPLY', 'SEND_MESSAGE']);
      expect(result.simple).toBe(false);
    });

    it('should handle IGNORE with no text', () => {
      const responseContent: Content = {
        text: '',
        actions: ['REPLY', 'IGNORE', 'SEND_MESSAGE'],
      };

      const result = handleAmbiguity(responseContent);

      // Should keep only IGNORE when no text
      expect(result.actions).toEqual(['IGNORE']);
      expect(result.simple).toBe(false);
    });
  });

  describe('Bug 2: Runtime Error Fix', () => {
    it('should handle non-string actions gracefully', () => {
      const responseContent: Content = {
        text: 'Hello world',
        actions: [null, undefined, 123, 'IGNORE', 'REPLY'],
      };

      const result = handleAmbiguity(responseContent);

      // Should handle IGNORE properly but keep non-string actions for now
      // (the actual implementation only filters IGNORE, not all non-strings)
      expect(result.actions).toEqual([null, undefined, 123, 'REPLY']);
      expect(result.simple).toBe(false); // Not simple because of non-string actions
    });

    it('should handle mixed string/non-string actions with IGNORE', () => {
      const responseContent: Content = {
        text: 'Hello world',
        actions: [null, 'IGNORE', undefined, 'REPLY'],
      };

      const result = handleAmbiguity(responseContent);

      // Should remove IGNORE but keep other actions including non-strings
      expect(result.actions).toEqual([null, undefined, 'REPLY']);
      expect(result.simple).toBe(false); // Not simple because of non-string actions
    });

    it('should handle case-insensitive IGNORE detection', () => {
      const responseContent: Content = {
        text: 'Hello world',
        actions: ['ignore', 'Ignore', 'IGNORE', 'REPLY'],
      };

      const result = handleAmbiguity(responseContent);

      // Should remove all IGNORE variants and keep REPLY
      expect(result.actions).toEqual(['REPLY']);
      expect(result.simple).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle single action (no ambiguity)', () => {
      const responseContent: Content = {
        text: 'Hello world',
        actions: ['REPLY'],
      };

      const result = handleAmbiguity(responseContent);

      // Should not modify single actions
      expect(result.actions).toEqual(['REPLY']);
      expect(result.simple).toBe(true);
    });

    it('should handle no actions', () => {
      const responseContent: Content = {
        text: 'Hello world',
        actions: [],
      };

      const result = handleAmbiguity(responseContent);

      // Should not modify empty actions
      expect(result.actions).toEqual([]);
      expect(result.simple).toBe(false);
    });

    it('should handle undefined actions', () => {
      const responseContent: Content = {
        text: 'Hello world',
      };

      const result = handleAmbiguity(responseContent);

      // Should not modify undefined actions
      expect(result.actions).toBeUndefined();
      expect(result.simple).toBe(false);
    });

    it('should handle all non-string actions', () => {
      const responseContent: Content = {
        text: 'Hello world',
        actions: [null, undefined, 123, {}],
      };

      const result = handleAmbiguity(responseContent);

      // Should not modify when no valid string actions
      expect(result.actions).toEqual([null, undefined, 123, {}]);
      expect(result.simple).toBe(false);
    });
  });
});

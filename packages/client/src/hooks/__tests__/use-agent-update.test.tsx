import { useAgentUpdate } from '../use-agent-update';
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook } from '@testing-library/react';

// Mock the usePartialUpdate hook instead of React core hooks
mock.module('../use-partial-update', () => ({
  usePartialUpdate: (initialValue: any) => {
    let currentValue = { ...initialValue };

    const updateFieldMock = mock((path: string, value: any) => {
      // Simple implementation to track updates
      const pathParts = path.split('.');

      if (pathParts.length === 1) {
        currentValue[path] = value;
      } else {
        // Handle nested paths (simplified)
        const [first, ...rest] = pathParts;
        if (!currentValue[first]) currentValue[first] = {};

        // Very simple implementation - doesn't handle complex nested paths
        let target = currentValue[first];
        for (let i = 0; i < rest.length - 1; i++) {
          if (!target[rest[i]]) target[rest[i]] = {};
          target = target[rest[i]];
        }
        target[rest[rest.length - 1]] = value;
      }
    });

    const addArrayItemMock = mock((path: string, item: any) => {
      const pathParts = path.split('.');
      if (pathParts.length === 1) {
        if (!Array.isArray(currentValue[path])) {
          currentValue[path] = [];
        }
        currentValue[path].push(item);
      }
    });

    const removeArrayItemMock = mock();
    const resetMock = mock();

    const updateSettingsMock = mock((settings: any) => {
      currentValue.settings = { ...currentValue.settings, ...settings };
    });

    return {
      value: currentValue,
      updateField: updateFieldMock,
      addArrayItem: addArrayItemMock,
      removeArrayItem: removeArrayItemMock,
      reset: resetMock,
      updateSettings: updateSettingsMock,
    };
  },
}));

// Define a simplified Agent type for our tests
type MockAgent = {
  name: string;
  username: string;
  system: string;
  bio: string[];
  topics: string[];
  adjectives: string[];
  plugins: string[];
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  settings: {
    avatar?: string;
    voice?: {
      model?: string;
      settings?: Record<string, any>;
    };
    secrets?: Record<string, string>;
    [key: string]: any;
  };
  [key: string]: any;
};

describe('useAgentUpdate hook', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    mock.restore();
  });

  afterEach(() => {
    // Clean up after each test
    mock.restore();
  });

  test('importAgent should call the appropriate update functions for all template fields', () => {
    // Create initial and template agents
    const initialAgent: MockAgent = {
      name: 'Initial Agent',
      username: 'initial_agent',
      system: 'Initial system prompt',
      bio: ['Initial bio'],
      topics: ['Initial topic'],
      adjectives: ['Initial adjective'],
      plugins: ['initial-plugin'],
      style: {
        all: ['Initial style all'],
        chat: ['Initial style chat'],
        post: ['Initial style post'],
      },
      settings: {
        avatar: 'initial-avatar.png',
        voice: {
          model: 'initial-voice-model',
        },
        secrets: {
          INITIAL_API_KEY: 'initial-key-value',
        },
      },
    };

    const templateAgent: MockAgent = {
      name: 'Template Agent',
      username: 'template_agent',
      system: 'Template system prompt',
      bio: ['Template bio 1', 'Template bio 2'],
      topics: ['Template topic 1', 'Template topic 2'],
      adjectives: ['Template adjective 1', 'Template adjective 2'],
      plugins: ['template-plugin-1', 'template-plugin-2'],
      style: {
        all: ['Template style all 1', 'Template style all 2'],
        chat: ['Template style chat 1', 'Template style chat 2'],
        post: ['Template style post 1', 'Template style post 2'],
      },
      settings: {
        avatar: 'template-avatar.png',
        voice: {
          model: 'template-voice-model',
        },
        secrets: {
          TEMPLATE_API_KEY: 'template-key-value',
        },
        newSetting: 'new-template-value',
      },
      extraField: 'extra-field-value',
    };

    // Use renderHook to properly test the React hook
    const { result } = renderHook(() => useAgentUpdate(initialAgent as any));

    // Get the necessary functions
    const { updateField, updateSettings } = result.current;

    // Call importAgent
    result.current.importAgent(templateAgent as any);

    // Verify that updateField or updateSettings was called for each field in the template

    // Check basic scalar fields
    expect(updateField).toHaveBeenCalledWith('name', templateAgent.name);
    expect(updateField).toHaveBeenCalledWith('username', templateAgent.username);
    expect(updateField).toHaveBeenCalledWith('system', templateAgent.system);

    // Check array fields
    expect(updateField).toHaveBeenCalledWith('bio', templateAgent.bio);
    expect(updateField).toHaveBeenCalledWith('topics', templateAgent.topics);
    expect(updateField).toHaveBeenCalledWith('adjectives', templateAgent.adjectives);
    expect(updateField).toHaveBeenCalledWith('plugins', templateAgent.plugins);

    // Check style fields
    expect(updateField).toHaveBeenCalledWith('style', {
      all: templateAgent.style.all,
      chat: templateAgent.style.chat,
      post: templateAgent.style.post,
    });

    // Check settings
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        ...initialAgent.settings,
        ...templateAgent.settings,
      })
    );

    // Check extra fields
    expect(updateField).toHaveBeenCalledWith('extraField', templateAgent.extraField);
  });

  test('importAgent should handle custom fields and nested objects', () => {
    // Create initial and template agents with complex nested structures
    const initialAgent: MockAgent = {
      name: 'Initial',
      username: 'initial',
      system: 'Initial',
      bio: [],
      topics: [],
      adjectives: [],
      plugins: [],
      style: { all: [], chat: [], post: [] },
      settings: {
        complexObject: {
          level1: {
            value: 'initial',
          },
        },
      },
    };

    const templateAgent: MockAgent = {
      name: 'Template',
      username: 'template',
      system: 'Template',
      bio: [],
      topics: [],
      adjectives: [],
      plugins: [],
      style: { all: [], chat: [], post: [] },
      settings: {
        complexObject: {
          level1: {
            value: 'template',
            newField: 'new',
          },
          level2: 'new level',
        },
      },
      customField: 'custom value',
    };

    // Use renderHook to properly test the React hook
    const { result } = renderHook(() => useAgentUpdate(initialAgent as any));

    // Get the necessary functions
    const { updateField, updateSettings } = result.current;

    // Call importAgent
    result.current.importAgent(templateAgent as any);

    // Verify updateSettings was called with the complex nested object
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        ...initialAgent.settings,
        ...templateAgent.settings,
      })
    );

    // Verify custom field was updated
    expect(updateField).toHaveBeenCalledWith('customField', templateAgent.customField);
  });
});

/**
 * @fileoverview Mock implementations for Character and related interfaces
 *
 * This module provides comprehensive mock implementations for character objects,
 * agent configurations, and personality definitions.
 */

import type { Character, MessageExample, UUID } from '@elizaos/core';

/**
 * Type representing overrides for Character mock creation
 */
export type MockCharacterOverrides = Partial<Character>;

/**
 * Create a comprehensive mock Character with intelligent defaults
 *
 * This function provides a fully-featured character mock that includes
 * realistic personality traits, message examples, and configuration.
 *
 * @param overrides - Partial object to override specific properties
 * @returns Complete mock Character object
 *
 * @example
 * ```typescript
 * import { createMockCharacter } from '@elizaos/core/test-utils';
 *
 * const mockCharacter = createMockCharacter({
 *   name: 'CustomAgent',
 *   bio: ['A specialized test agent'],
 *   plugins: ['@elizaos/plugin-test']
 * });
 * ```
 */
export function createMockCharacter(overrides: MockCharacterOverrides = {}): Character {
  const baseCharacter: Character = {
    id: 'test-character-id' as UUID,
    name: 'TestAgent',
    username: 'test_agent',
    system:
      'You are a helpful test assistant designed for automated testing scenarios. Respond concisely and clearly.',

    bio: [
      'A test agent designed for comprehensive testing scenarios',
      'Provides consistent, predictable responses for test validation',
      'Supports all core ElizaOS features and plugin interactions',
      'Maintains conversation context and handles complex workflows',
      'Optimized for both unit and integration testing environments',
    ],

    messageExamples: [
      [
        {
          name: '{{user}}',
          content: {
            text: 'Hello, how are you?',
          },
        },
        {
          name: 'TestAgent',
          content: {
            text: "Hello! I'm doing well, thank you for asking. How can I help you today?",
          },
        },
      ],
      [
        {
          name: '{{user}}',
          content: {
            text: 'Can you help me test this feature?',
          },
        },
        {
          name: 'TestAgent',
          content: {
            text: "Absolutely! I'm designed specifically to help with testing. What feature would you like to test?",
          },
        },
      ],
      [
        {
          name: '{{user}}',
          content: {
            text: 'What capabilities do you have?',
          },
        },
        {
          name: 'TestAgent',
          content: {
            text: 'I can assist with testing various ElizaOS features including actions, providers, services, and plugin functionality.',
          },
        },
      ],
    ],

    postExamples: [
      'Testing new ElizaOS features today - everything looking good!',
      'Just validated another plugin integration - the ecosystem keeps growing',
      'Reminder: always test your agents thoroughly before deployment',
      'Quality assurance is key to reliable AI agent systems',
    ],

    topics: [
      'software testing',
      'quality assurance',
      'test automation',
      'agent behavior validation',
      'plugin integration',
      'system reliability',
      'debugging',
      'performance testing',
    ],

    knowledge: [
      'ElizaOS architecture and patterns',
      'Test-driven development practices',
      'Quality assurance methodologies',
      'Plugin system integration',
      'Agent behavior patterns',
      'Debugging and troubleshooting',
    ],

    plugins: ['@elizaos/plugin-sql', '@elizaos/plugin-bootstrap'],

    settings: {
      model: 'gpt-4',
      temperature: 0.1, // Low temperature for consistent test responses
      maxTokens: 1000,
      secrets: {},
      voice: {
        model: 'en_US-hfc_female-medium',
      },
      embeddingModel: 'text-embedding-ada-002',
      ...overrides.settings,
    },

    secrets: {
      TEST_API_KEY: 'test-api-key-value',
      MOCK_SECRET: 'mock-secret-value',
      ...overrides.secrets,
    },

    style: {
      all: [
        'be helpful and supportive',
        'provide clear and concise responses',
        'maintain professional tone',
        'focus on testing and quality assurance',
        'be thorough in explanations',
      ],
      chat: [
        'respond promptly',
        'ask clarifying questions when needed',
        'provide actionable guidance',
        'maintain conversational flow',
      ],
      post: [
        'share testing insights',
        'promote quality practices',
        'be informative and educational',
        'encourage best practices',
      ],
    },

    // Apply all overrides
    ...overrides,
  };

  return baseCharacter;
}

/**
 * Create a minimal mock character with only required fields
 *
 * @param name - Character name
 * @param overrides - Additional overrides
 * @returns Minimal mock character
 */
export function createMinimalMockCharacter(
  name: string = 'MinimalTestAgent',
  overrides: MockCharacterOverrides = {}
): Character {
  return createMockCharacter({
    name,
    bio: [`${name} - A minimal test agent`],
    messageExamples: [
      [
        { name: '{{user}}', content: { text: 'Hello' } },
        { name, content: { text: 'Hi there!' } },
      ],
    ],
    topics: ['testing'],
    plugins: [],
    ...overrides,
  });
}

/**
 * Create a mock character for specific plugin testing
 *
 * @param pluginName - Name of the plugin to test
 * @param overrides - Additional overrides
 * @returns Plugin-specific mock character
 */
export function createPluginTestCharacter(
  pluginName: string,
  overrides: MockCharacterOverrides = {}
): Character {
  return createMockCharacter({
    name: `${pluginName}TestAgent`,
    bio: [`Agent designed to test ${pluginName} plugin functionality`],
    plugins: [pluginName],
    topics: [`${pluginName} testing`, 'plugin integration'],
    knowledge: [`${pluginName} plugin documentation and usage`],
    ...overrides,
  });
}

/**
 * Create a mock character with extensive conversation examples
 *
 * @param overrides - Additional overrides
 * @returns Character with rich conversation examples
 */
export function createRichConversationCharacter(overrides: MockCharacterOverrides = {}): Character {
  const additionalExamples: MessageExample[][] = [
    [
      { name: '{{user}}', content: { text: 'Can you perform an action?' } },
      {
        name: 'TestAgent',
        content: {
          text: 'I can perform various actions based on available plugins.',
          actions: ['TEST_ACTION'],
        },
      },
    ],
    [
      { name: '{{user}}', content: { text: 'What do you think about that?' } },
      {
        name: 'TestAgent',
        content: {
          text: 'Based on our conversation, I think this is a good approach.',
          thought: 'The user is asking for my analysis of the previous topic.',
        },
      },
    ],
    [
      { name: '{{user}}', content: { text: 'Remember this important fact: X equals Y' } },
      {
        name: 'TestAgent',
        content: {
          text: "I'll remember that X equals Y. This has been noted for future reference.",
        },
      },
    ],
  ];

  return createMockCharacter({
    messageExamples: [...(createMockCharacter().messageExamples || []), ...additionalExamples],
    postExamples: [
      'Just had an interesting conversation about X and Y relationships',
      'Learning new facts every day through conversations',
      'Testing advanced conversation patterns',
      'Exploring the depths of agent-user interactions',
    ],
    ...overrides,
  });
}

/**
 * Create multiple mock characters for multi-agent testing
 *
 * @param count - Number of characters to create
 * @param baseName - Base name for characters (will be numbered)
 * @param overrides - Common overrides for all characters
 * @returns Array of mock characters
 */
export function createMultipleCharacters(
  count: number = 3,
  baseName: string = 'TestAgent',
  overrides: MockCharacterOverrides = {}
): Character[] {
  const characters: Character[] = [];

  for (let i = 1; i <= count; i++) {
    const character = createMockCharacter({
      name: `${baseName}${i}`,
      username: `${baseName.toLowerCase()}${i}`,
      id: `test-character-${i}-id` as UUID,
      bio: [`${baseName}${i} - Agent ${i} in a multi-agent test scenario`],
      ...overrides,
    });

    characters.push(character);
  }

  return characters;
}

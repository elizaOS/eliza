import { describe, expect, it } from 'vitest';
import { validateCharacterConfig } from '../src/environment';

describe('Character Configuration', () => {
  const validCharacterConfig = {
    name: 'Test Character',
    bio: 'Test bio',
    messageExamples: [
      [
        {
          name: 'name1',
          content: {
            text: 'Hello',
          },
        },
      ],
    ],
    postExamples: ['Test post'],
    topics: ['topic1'],
    adjectives: ['friendly'],
    clients: ['discord'],
    plugins: ['test-plugin'],
    style: {
      all: ['style1'],
      chat: ['chat-style'],
      post: ['post-style'],
    },
  };

  it('should validate correct character configuration', () => {
    expect(() => validateCharacterConfig(validCharacterConfig)).not.toThrow();
  });

  it('should validate configuration with optional fields', () => {
    const configWithOptionals = {
      ...validCharacterConfig,
      id: '123e4567-e89b-12d3-a456-426614174000',
      system: 'Test system',
      templates: {
        greeting: 'Hello!',
      },
      knowledge: ['fact1'],
      settings: {
        secrets: {
          key: 'value',
        },
        voice: {
          model: 'test-model',
          url: 'http://example.com',
        },
      },
    };
    expect(() => validateCharacterConfig(configWithOptionals)).not.toThrow();
  });

  it('should throw error for missing required fields', () => {
    const invalidConfig = { ...validCharacterConfig };
    (invalidConfig as any).name = undefined;
    expect(() => validateCharacterConfig(invalidConfig)).toThrow();
  });

  it('should validate plugin objects in plugins array', () => {
    const configWithPluginObjects = {
      ...validCharacterConfig,
      plugins: [
        {
          name: 'test-plugin',
          description: 'Test description',
        },
      ],
    };
    expect(() => validateCharacterConfig(configWithPluginObjects)).not.toThrow();
  });

  it('should validate message examples with additional properties', () => {
    const configWithComplexMessage = {
      ...validCharacterConfig,
      messageExamples: [
        [
          {
            name: 'name1',
            content: {
              text: 'Hello',
              action: 'wave',
              source: 'chat',
              url: 'http://example.com',
              inReplyTo: '123e4567-e89b-12d3-a456-426614174000',
              attachments: ['file1'],
              customField: 'value',
            },
          },
        ],
      ],
    };
    expect(() => validateCharacterConfig(configWithComplexMessage)).not.toThrow();
  });
});

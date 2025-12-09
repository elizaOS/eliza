import { describe, it, expect, beforeEach } from 'bun:test';
import { mock } from 'bun:test';
import { AgentRuntime } from '../runtime';
import { ModelType } from '../types/model';
import type { Character } from '../types';
import { stringToUuid } from '../utils';

describe('generateText', () => {
  let runtime: AgentRuntime;
  let mockUseModel: ReturnType<typeof mock<AgentRuntime['useModel']>>;

  const mockCharacter: Character = {
    id: stringToUuid('test-character'),
    name: 'TestBot',
    bio: 'A helpful AI assistant for testing',
    system: 'You are a friendly and helpful assistant.',
    style: {
      all: ['Be concise', 'Be friendly'],
      chat: ['Use casual language'],
    },
  };

  beforeEach(() => {
    // Create a minimal runtime instance
    runtime = new AgentRuntime({
      character: mockCharacter,
    });

    // Mock the useModel method
    mockUseModel = mock().mockResolvedValue('Generated response text');
    runtime.useModel = mockUseModel;
  });

  it('should generate text with character context by default', async () => {
    const input = 'Tell me about quantum computing';
    const result = await runtime.generateText(input);

    expect(result).toHaveProperty('text');
    expect(result.text).toBe('Generated response text');
    expect(mockUseModel).toHaveBeenCalledTimes(1);

    // Verify the model was called with TEXT_LARGE
    const callArgs = mockUseModel.mock.calls[0];
    expect(callArgs[0]).toBe(ModelType.TEXT_LARGE);

    // Verify the prompt includes character context
    const params = callArgs[1];
    expect(params.prompt).toContain('About TestBot');
    expect(params.prompt).toContain('A helpful AI assistant for testing');
    expect(params.prompt).toContain('You are a friendly and helpful assistant');
    expect(params.prompt).toContain('Be concise');
    expect(params.prompt).toContain('Tell me about quantum computing');
  });

  it('should generate text without character context when includeCharacter is false', async () => {
    const input = 'Translate to Spanish: Hello';
    const result = await runtime.generateText(input, {
      includeCharacter: false,
    });

    expect(result).toHaveProperty('text');
    expect(result.text).toBe('Generated response text');
    expect(mockUseModel).toHaveBeenCalledTimes(1);

    // Verify the prompt does NOT include character context
    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    expect(params.prompt).toBe('Translate to Spanish: Hello');
    expect(params.prompt).not.toContain('About TestBot');
  });

  it('should use specified model type', async () => {
    const input = 'Simple task';
    await runtime.generateText(input, {
      modelType: ModelType.TEXT_SMALL,
    });

    expect(mockUseModel).toHaveBeenCalledTimes(1);

    // Verify TEXT_SMALL was used
    const callArgs = mockUseModel.mock.calls[0];
    expect(callArgs[0]).toBe(ModelType.TEXT_SMALL);
  });

  it('should pass through generation parameters', async () => {
    const input = 'Write a creative story';
    await runtime.generateText(input, {
      includeCharacter: false,
      temperature: 0.9,
      topP: 0.95,
      topK: 40,
      minP: 0.05,
      seed: 42,
      repetitionPenalty: 1.1,
      maxTokens: 500,
      minTokens: 50,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
      stopSequences: ['\n\n', 'END'],
      user: 'custom-user-id',
      responseFormat: { type: 'json_object' },
    });

    expect(mockUseModel).toHaveBeenCalledTimes(1);

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    expect(params.temperature).toBe(0.9);
    expect(params.topP).toBe(0.95);
    expect(params.topK).toBe(40);
    expect(params.minP).toBe(0.05);
    expect(params.seed).toBe(42);
    expect(params.repetitionPenalty).toBe(1.1);
    expect(params.maxTokens).toBe(500);
    expect(params.minTokens).toBe(50);
    expect(params.frequencyPenalty).toBe(0.5);
    expect(params.presencePenalty).toBe(0.3);
    expect(params.stopSequences).toEqual(['\n\n', 'END']);
    expect(params.user).toBe('custom-user-id');
    expect(params.responseFormat).toEqual({ type: 'json_object' });
  });

  it('should auto-populate user from character name when not provided', async () => {
    const input = 'Test prompt';
    await runtime.generateText(input, {
      includeCharacter: false,
    });

    expect(mockUseModel).toHaveBeenCalledTimes(1);

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    // Should auto-populate from character name
    expect(params.user).toBe('TestBot');
  });

  it('should preserve explicitly provided empty string for user parameter', async () => {
    const input = 'Test prompt';
    await runtime.generateText(input, {
      includeCharacter: false,
      user: '',
    });

    expect(mockUseModel).toHaveBeenCalledTimes(1);

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    // Should preserve empty string, not override with character name
    expect(params.user).toBe('');
  });

  it('should preserve explicitly provided null for user parameter', async () => {
    const input = 'Test prompt';
    await runtime.generateText(input, {
      includeCharacter: false,
      user: null,
    });

    expect(mockUseModel).toHaveBeenCalledTimes(1);

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    // Should preserve null, not override with character name
    expect(params.user).toBeNull();
  });

  it('should handle character with array bio', async () => {
    const characterWithArrayBio: Character = {
      ...mockCharacter,
      bio: ['Fact 1 about bot', 'Fact 2 about bot', 'Fact 3 about bot'],
    };

    runtime = new AgentRuntime({
      character: characterWithArrayBio,
    });
    mockUseModel = mock().mockResolvedValue('Response');
    runtime.useModel = mockUseModel;

    await runtime.generateText('Test input');

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    expect(params.prompt).toContain('Fact 1 about bot');
    expect(params.prompt).toContain('Fact 2 about bot');
    expect(params.prompt).toContain('Fact 3 about bot');
  });

  it('should handle character with minimal information', async () => {
    const minimalCharacter: Character = {
      id: stringToUuid('minimal'),
      name: 'MinimalBot',
      bio: '',
    };

    runtime = new AgentRuntime({
      character: minimalCharacter,
    });
    mockUseModel = mock().mockResolvedValue('Response');
    runtime.useModel = mockUseModel;

    const input = 'Test input';
    const result = await runtime.generateText(input, {
      includeCharacter: true,
    });

    expect(result.text).toBe('Response');

    // Should still work, just won't add much context
    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    expect(params.prompt).toContain('Test input');
  });

  it('should handle empty style directives', async () => {
    const characterNoStyle: Character = {
      id: stringToUuid('no-style'),
      name: 'NoStyleBot',
      bio: 'A bot without style',
      system: 'System prompt',
      style: {
        all: [],
        chat: [],
      },
    };

    runtime = new AgentRuntime({
      character: characterNoStyle,
    });
    mockUseModel = mock().mockResolvedValue('Response');
    runtime.useModel = mockUseModel;

    await runtime.generateText('Test');

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    expect(params.prompt).toContain('A bot without style');
    expect(params.prompt).toContain('System prompt');
    expect(params.prompt).not.toContain('Style:');
  });

  it('should combine all + chat style directives', async () => {
    const input = 'Test input';
    await runtime.generateText(input);

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    expect(params.prompt).toContain('Be concise');
    expect(params.prompt).toContain('Be friendly');
    expect(params.prompt).toContain('Use casual language');
  });

  it('should return text property in result', async () => {
    mockUseModel.mockResolvedValue('Custom response');

    const result = await runtime.generateText('Any input');

    expect(result).toEqual({ text: 'Custom response' });
  });

  it('should propagate errors from useModel', async () => {
    mockUseModel.mockRejectedValue(new Error('Model error'));

    await expect(runtime.generateText('Test')).rejects.toThrow('Model error');
  });

  it('should work with custom model type and character context', async () => {
    const input = 'Complex reasoning task';
    await runtime.generateText(input, {
      modelType: ModelType.TEXT_REASONING_LARGE,
      temperature: 0.3,
    });

    const callArgs = mockUseModel.mock.calls[0];
    expect(callArgs[0]).toBe(ModelType.TEXT_REASONING_LARGE);

    const params = callArgs[1];
    expect(params.temperature).toBe(0.3);
    expect(params.prompt).toContain('About TestBot'); // Character context included
  });

  it('should handle responseFormat as string', async () => {
    const input = 'Generate JSON';
    await runtime.generateText(input, {
      includeCharacter: false,
      responseFormat: 'json',
    });

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    expect(params.responseFormat).toBe('json');
  });

  it('should handle empty stopSequences array', async () => {
    const input = 'Test prompt';
    await runtime.generateText(input, {
      includeCharacter: false,
      stopSequences: [],
    });

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    expect(params.stopSequences).toEqual([]);
  });

  it('should handle missing character name for user auto-population', async () => {
    const characterNoName: Character = {
      id: stringToUuid('no-name'),
      name: '',
      bio: 'Test bio',
    };

    runtime = new AgentRuntime({
      character: characterNoName,
    });
    mockUseModel = mock().mockResolvedValue('Response');
    runtime.useModel = mockUseModel;

    await runtime.generateText('Test', {
      includeCharacter: false,
    });

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    // Should use empty string if character name is empty
    expect(params.user).toBe('');
  });

  it('should handle undefined character for user auto-population', async () => {
    runtime = new AgentRuntime({
      character: undefined as Character | undefined,
    });
    mockUseModel = mock().mockResolvedValue('Response');
    runtime.useModel = mockUseModel;

    await runtime.generateText('Test', {
      includeCharacter: false,
    });

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];
    // Should use undefined if character is missing
    expect(params.user).toBeUndefined();
  });

  it('should handle all parameters being undefined', async () => {
    const input = 'Simple prompt';
    await runtime.generateText(input, {
      includeCharacter: false,
    });

    const callArgs = mockUseModel.mock.calls[0];
    const params = callArgs[1];

    // Verify required params exist
    expect(params.prompt).toBe('Simple prompt');
    expect(params.user).toBe('TestBot'); // Auto-populated

    // Verify optional params are not set when not provided
    expect(params.maxTokens).toBeUndefined();
    expect(params.minTokens).toBeUndefined();
    expect(params.temperature).toBeUndefined();
    expect(params.topP).toBeUndefined();
    expect(params.topK).toBeUndefined();
    expect(params.minP).toBeUndefined();
    expect(params.seed).toBeUndefined();
    expect(params.repetitionPenalty).toBeUndefined();
    expect(params.frequencyPenalty).toBeUndefined();
    expect(params.presencePenalty).toBeUndefined();
    expect(params.stopSequences).toBeUndefined();
    expect(params.responseFormat).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';

const mockLanguageModel = mock((model: string) => `language-model:${model}`);
const mockCreateGroq = mock(() => ({
  languageModel: mockLanguageModel,
}));
const mockGenerateText = mock(async () => ({ text: 'mocked response' }));
const mockGenerateObject = mock(async () => ({ object: { ok: true } }));
const mockLogPrompt = mock(async () => undefined);

mock.module('@ai-sdk/groq', () => ({
  createGroq: mockCreateGroq,
}));

mock.module('ai', () => ({
  generateObject: mockGenerateObject,
  generateText: mockGenerateText,
}));

mock.module('@feed/shared', () => ({
  GROQ_MODELS: {
    FREE: { modelId: 'groq-small-model' },
    PRO: { modelId: 'groq-large-model' },
  },
}));

mock.module('@elizaos/core', () => ({
  ModelType: {
    OBJECT_LARGE: 'object_large',
    OBJECT_SMALL: 'object_small',
    TEXT_LARGE: 'text_large',
    TEXT_SMALL: 'text_small',
    TEXT_TOKENIZER_DECODE: 'text_tokenizer_decode',
    TEXT_TOKENIZER_ENCODE: 'text_tokenizer_encode',
  },
}));

mock.module('js-tiktoken', () => ({
  encodingForModel: mock(() => ({
    decode: mock(() => ''),
    encode: mock(() => []),
  })),
}));

mock.module('../../shared/logger', () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

mock.module('../../utils/prompt-logger', () => ({
  isPromptLoggingEnabled: () => false,
  logPrompt: mockLogPrompt,
}));

const { ModelType } = await import('@elizaos/core');
const { groqPlugin } = await import('../groq');

const runtime = {
  character: { system: 'System prompt' },
  fetch: undefined,
  getSetting: (key: string) => {
    if (key === 'GROQ_API_KEY') return 'test-groq-key';
    if (key === 'GROQ_BASE_URL') return 'https://groq.example';
    return undefined;
  },
} as unknown as IAgentRuntime;

const runtimeWithModelOverride = {
  character: { system: 'System prompt' },
  fetch: undefined,
  getSetting: (key: string) => {
    if (key === 'GROQ_API_KEY') return 'test-groq-key';
    if (key === 'GROQ_BASE_URL') return 'https://proxy.example/v1';
    if (key === 'GROQ_SMALL_MODEL') return 'proxy-small';
    if (key === 'GROQ_LARGE_MODEL') return 'proxy-large';
    if (key === 'GROQ_PRIMARY_MODEL') return 'proxy-primary';
    return undefined;
  },
} as unknown as IAgentRuntime;

describe('groqPlugin TEXT_SMALL', () => {
  beforeEach(() => {
    mockCreateGroq.mockClear();
    mockLanguageModel.mockClear();
    mockGenerateText.mockClear();
    mockGenerateObject.mockClear();
    mockLogPrompt.mockClear();
  });

  it('passes caller-provided generation params through to Groq', async () => {
    const response = await groqPlugin.models[ModelType.TEXT_SMALL]?.(runtime, {
      frequencyPenalty: 0.2,
      maxTokens: 321,
      presencePenalty: 0.1,
      prompt: 'tell my agent to buy TSLAI',
      stopSequences: ['</response>'],
      temperature: 0.4,
    });

    expect(response).toBe('mocked response');
    expect(mockCreateGroq).toHaveBeenCalledWith({
      apiKey: 'test-groq-key',
      baseURL: 'https://groq.example',
      fetch: undefined,
    });
    expect(mockLanguageModel).toHaveBeenCalledWith('groq-small-model');
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        frequencyPenalty: 0.2,
        maxOutputTokens: 321,
        model: 'language-model:groq-small-model',
        presencePenalty: 0.1,
        prompt: 'tell my agent to buy TSLAI',
        stopSequences: ['</response>'],
        system: 'System prompt',
        temperature: 0.4,
      })
    );
  });

  it('keeps the previous defaults when caller params are omitted', async () => {
    await groqPlugin.models[ModelType.TEXT_SMALL]?.(runtime, {
      prompt: 'default params',
    });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        frequencyPenalty: 0.7,
        maxOutputTokens: 8000,
        presencePenalty: 0.7,
        prompt: 'default params',
        stopSequences: [],
        temperature: 0.7,
      })
    );
  });

  it('uses runtime model overrides for small and large routes', async () => {
    await groqPlugin.models[ModelType.TEXT_SMALL]?.(runtimeWithModelOverride, {
      prompt: 'small route',
    });
    await groqPlugin.models[ModelType.TEXT_LARGE]?.(runtimeWithModelOverride, {
      prompt: 'large route',
    });

    expect(mockCreateGroq).toHaveBeenCalledWith({
      apiKey: 'test-groq-key',
      baseURL: 'https://proxy.example/v1',
      fetch: undefined,
    });
    expect(mockLanguageModel).toHaveBeenCalledWith('proxy-small');
    expect(mockLanguageModel).toHaveBeenCalledWith('proxy-large');
  });
});

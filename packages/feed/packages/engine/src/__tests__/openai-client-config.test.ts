import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const openAiConfigs: Array<Record<string, unknown>> = [];

mock.module('openai', () => ({
  default: class MockOpenAI {
    public chat = {
      completions: {
        create: async () => ({
          choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
      },
    };

    constructor(config: Record<string, unknown>) {
      openAiConfigs.push(config);
    }
  },
}));

describe('BabylonLLMClient configuration', () => {
  const originalGroqApiKey = process.env.GROQ_API_KEY;
  const originalGroqBaseURL = process.env.GROQ_BASE_URL;
  const originalMarketDecisionModel = process.env.MARKET_DECISION_MODEL;

  beforeEach(() => {
    openAiConfigs.length = 0;
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_BASE_URL;
    delete process.env.MARKET_DECISION_MODEL;
  });

  afterEach(() => {
    if (originalGroqApiKey === undefined) {
      delete process.env.GROQ_API_KEY;
    } else {
      process.env.GROQ_API_KEY = originalGroqApiKey;
    }

    if (originalGroqBaseURL === undefined) {
      delete process.env.GROQ_BASE_URL;
    } else {
      process.env.GROQ_BASE_URL = originalGroqBaseURL;
    }

    if (originalMarketDecisionModel === undefined) {
      delete process.env.MARKET_DECISION_MODEL;
    } else {
      process.env.MARKET_DECISION_MODEL = originalMarketDecisionModel;
    }
  });

  test('uses GROQ_BASE_URL and MARKET_DECISION_MODEL overrides', async () => {
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.GROQ_BASE_URL = 'http://127.0.0.1:8099/v1';
    process.env.MARKET_DECISION_MODEL = 'adapter';

    const { BabylonLLMClient } = await import('../llm/openai-client');
    const client = BabylonLLMClient.forGameTick();

    expect(openAiConfigs.at(-1)).toMatchObject({
      apiKey: 'test-groq-key',
      baseURL: 'http://127.0.0.1:8099/v1',
    });
    expect(client.getStats().model).toBe('adapter');
  });
});

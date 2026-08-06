import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildZaiSlideAgentExportRequest,
  buildZaiSlideAgentRequest,
  extractZaiSlideAgentText,
  extractZaiSlideAgentUrls,
  getZaiEnvConfig,
  normalizeZaiReasoningEffort,
  normalizeZaiThinking,
  ZAI_AGENT_BASE_URL,
  ZAI_BASE_URL,
  ZAI_DEFAULT_MODEL,
  ZAI_IMAGE_MODEL,
  ZAI_SLIDE_AGENT_ID,
  ZAI_TRADE_VISION_MODEL,
  ZAI_VISION_MODEL,
} from './zai.js';

describe('Z.AI environment config', () => {
  test('uses GLM defaults out of the box', () => {
    const config = getZaiEnvConfig({});

    assert.equal(config.baseUrl, ZAI_BASE_URL);
    assert.equal(config.agentBaseUrl, ZAI_AGENT_BASE_URL);
    assert.equal(config.model, ZAI_DEFAULT_MODEL);
    assert.equal(config.chartModel, ZAI_DEFAULT_MODEL);
    assert.equal(config.visionModel, ZAI_VISION_MODEL);
    assert.equal(config.tradeVisionModel, ZAI_TRADE_VISION_MODEL);
    assert.equal(config.chartVisionModel, ZAI_TRADE_VISION_MODEL);
    assert.equal(config.imageModel, ZAI_IMAGE_MODEL);
    assert.equal(config.thinkingType, 'enabled');
    assert.equal(config.reasoningEffort, 'max');
  });

  test('normalizes thinking mode', () => {
    assert.equal(normalizeZaiThinking(undefined), 'enabled');
    assert.equal(normalizeZaiThinking('off'), 'disabled');
    assert.equal(normalizeZaiThinking('false'), 'disabled');
    assert.equal(normalizeZaiThinking('enabled'), 'enabled');
  });

  test('normalizes reasoning effort', () => {
    assert.equal(normalizeZaiReasoningEffort(undefined), 'max');
    assert.equal(normalizeZaiReasoningEffort('HIGH'), 'high');
    assert.equal(normalizeZaiReasoningEffort('minimal'), 'minimal');
    assert.equal(normalizeZaiReasoningEffort('invalid'), 'max');
  });

  test('honors env overrides and trims base url', () => {
    const config = getZaiEnvConfig({
      ZAI_BASE_URL: 'https://example.test/v4///',
      ZAI_AGENT_BASE_URL: 'https://agent.example.test/v1///',
      ZAI_MODEL: 'glm-5.2-custom',
      ZAI_CHART_MODEL: 'glm-chart-custom',
      ZAI_VISION_MODEL: 'glm-5v-custom',
      ZAI_CHART_VISION_MODEL: 'glm-chart-vision-custom',
      ZAI_IMAGE_MODEL: 'glm-image-custom',
      ZAI_THINKING: 'disabled',
      ZAI_REASONING_EFFORT: 'low',
    });

    assert.equal(config.baseUrl, 'https://example.test/v4');
    assert.equal(config.agentBaseUrl, 'https://agent.example.test/v1');
    assert.equal(config.model, 'glm-5.2-custom');
    assert.equal(config.chartModel, 'glm-chart-custom');
    assert.equal(config.visionModel, 'glm-5v-custom');
    assert.equal(config.tradeVisionModel, 'glm-5v-custom');
    assert.equal(config.chartVisionModel, 'glm-chart-vision-custom');
    assert.equal(config.imageModel, 'glm-image-custom');
    assert.equal(config.thinkingType, 'disabled');
    assert.equal(config.reasoningEffort, 'low');
  });
});

describe('Z.AI slide/poster agent helpers', () => {
  test('builds slides_glm_agent request bodies', () => {
    assert.deepEqual(buildZaiSlideAgentRequest({
      prompt: 'Create a market deck',
      conversationId: 'conv-1',
      requestId: 'req-1',
    }), {
      agent_id: ZAI_SLIDE_AGENT_ID,
      stream: false,
      conversation_id: 'conv-1',
      request_id: 'req-1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Create a market deck' },
          ],
        },
      ],
    });
  });

  test('builds slide export request bodies', () => {
    assert.deepEqual(buildZaiSlideAgentExportRequest({
      conversationId: 'conv-1',
      includePdf: true,
      pages: [{ position: 1, width: 960, height: 540 }],
    }), {
      agent_id: ZAI_SLIDE_AGENT_ID,
      conversation_id: 'conv-1',
      custom_variables: {
        include_pdf: true,
        pages: [{ position: 1, width: 960, height: 540 }],
      },
    });
  });

  test('extracts text and export urls from agent responses', () => {
    const response = {
      choices: [
        {
          message: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Deck created.' },
                { type: 'object', object: { output: '<html>slide</html>' } },
                { type: 'file_url', tag_en: 'PDF', file_url: 'https://example.test/deck.pdf' },
                { type: 'image_url', tag_en: 'Preview', image_url: 'https://example.test/slide.png' },
              ],
            },
          ],
        },
      ],
    };

    assert.equal(extractZaiSlideAgentText(response), 'Deck created.\n<html>slide</html>');
    assert.deepEqual(extractZaiSlideAgentUrls(response), [
      { type: 'file', url: 'https://example.test/deck.pdf', tag: 'PDF' },
      { type: 'image', url: 'https://example.test/slide.png', tag: 'Preview' },
    ]);
  });
});

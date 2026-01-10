import { Provider, ModelType, composePrompt } from '@elizaos/core';
import type { ClassificationResult } from '../types';
import { messageClassifierTemplate } from '../generated/prompts/typescript/prompts.js';

export const messageClassifierProvider: Provider = {
  name: 'messageClassifier',
  description:
    'Classifies incoming messages by complexity and planning requirements using intelligent LLM analysis. Use to determine if strategic planning, sequential execution, or direct action is needed.',

  get: async (runtime, message, _state) => {
    const text = message.content.text || '';

    if (!text.trim()) {
      return {
        text: 'Message classified as: general (empty message)',
        data: {
          classification: 'general',
          confidence: 0.1,
          complexity: 'simple',
          planningRequired: false,
          stakeholders: [],
          constraints: [],
        } as ClassificationResult,
      };
    }

    try {
      const classificationPrompt = composePrompt({
        state: {
          text,
        },
        template: messageClassifierTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: classificationPrompt,
        temperature: 0.3,
        maxTokens: 300,
      });

      const responseText = response as string;
      const lines = responseText.split('\n');

      const parseField = (prefix: string): string[] => {
        const line = lines.find((l) => l.startsWith(prefix));
        if (!line) {
          return [];
        }
        const value = line.substring(prefix.length).trim();
        return value
          ? value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : [];
      };

      const complexity =
        lines
          .find((l) => l.startsWith('COMPLEXITY:'))
          ?.substring(11)
          .trim() || 'simple';
      const planningType =
        lines
          .find((l) => l.startsWith('PLANNING:'))
          ?.substring(9)
          .trim() || 'direct_action';
      const confidenceStr =
        lines
          .find((l) => l.startsWith('CONFIDENCE:'))
          ?.substring(11)
          .trim() || '0.5';
      const confidence = Math.min(1.0, Math.max(0.0, parseFloat(confidenceStr) || 0.5));

      const capabilities = parseField('CAPABILITIES:');
      const stakeholders = parseField('STAKEHOLDERS:');
      const constraints = parseField('CONSTRAINTS:');
      const dependencies = parseField('DEPENDENCIES:');

      const planningRequired = planningType !== 'direct_action' && complexity !== 'simple';

      let legacyClassification = 'general';
      if (text.toLowerCase().includes('strategic') || planningType === 'strategic_planning') {
        legacyClassification = 'strategic';
      } else if (text.toLowerCase().includes('analyz')) {
        legacyClassification = 'analysis';
      } else if (text.toLowerCase().includes('process')) {
        legacyClassification = 'processing';
      } else if (text.toLowerCase().includes('execute')) {
        legacyClassification = 'execution';
      }

      return {
        text: `Message classified as: ${legacyClassification} (${complexity} complexity, ${planningType}) with confidence: ${confidence}`,
        data: {
          classification: legacyClassification,
          confidence,
          originalText: text,
          complexity,
          planningType,
          planningRequired,
          capabilities,
          stakeholders,
          constraints,
          dependencies,
          analyzedAt: Date.now(),
          modelUsed: 'TEXT_SMALL',
        } as ClassificationResult & { originalText: string; analyzedAt: number; modelUsed: string },
      };
    } catch (error) {
      const text_lower = text.toLowerCase();
      let classification = 'general';
      let confidence = 0.5;

      if (
        text_lower.includes('strategy') ||
        text_lower.includes('plan') ||
        text_lower.includes('strategic')
      ) {
        classification = 'strategic';
        confidence = 0.7;
      } else if (text_lower.includes('analyze') || text_lower.includes('analysis')) {
        classification = 'analysis';
        confidence = 0.8;
      } else if (text_lower.includes('process') || text_lower.includes('processing')) {
        classification = 'processing';
        confidence = 0.8;
      } else if (text_lower.includes('execute') || text_lower.includes('final')) {
        classification = 'execution';
        confidence = 0.8;
      }

      return {
        text: `Message classified as: ${classification} with confidence: ${confidence} (fallback)`,
        data: {
          classification,
          confidence,
          originalText: text,
          complexity: 'simple',
          planningRequired: false,
          planningType: 'direct_action',
          capabilities: [],
          stakeholders: [],
          constraints: [],
          dependencies: [],
          error: (error as Error).message,
          fallback: true,
        },
      };
    }
  },
};


import { Provider, ModelType } from '@elizaos/core';

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
        },
      };
    }

    try {
      // Use real LLM for intelligent classification
      const classificationPrompt = `Analyze this user request and classify it for planning purposes:

"${text}"

Classify the request across these dimensions:

1. COMPLEXITY LEVEL:
- simple: Direct actions that don't require planning
- medium: Multi-step tasks requiring coordination  
- complex: Strategic initiatives with multiple stakeholders
- enterprise: Large-scale transformations with full complexity

2. PLANNING TYPE:
- direct_action: Single action, no planning needed
- sequential_planning: Multiple steps in sequence
- strategic_planning: Complex coordination with stakeholders

3. REQUIRED CAPABILITIES:
- List specific capabilities needed (analysis, communication, project_management, etc.)

4. STAKEHOLDERS:
- List types of people/groups involved

5. CONSTRAINTS:
- List limitations or requirements mentioned

6. DEPENDENCIES:
- List dependencies between tasks or external factors

Respond in this exact format:
COMPLEXITY: [simple|medium|complex|enterprise]
PLANNING: [direct_action|sequential_planning|strategic_planning]  
CAPABILITIES: [comma-separated list]
STAKEHOLDERS: [comma-separated list]
CONSTRAINTS: [comma-separated list]
DEPENDENCIES: [comma-separated list]
CONFIDENCE: [0.0-1.0]`;

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: classificationPrompt,
        temperature: 0.3,
        maxTokens: 300,
      });

      // Parse LLM response
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

      // Determine if planning is required
      const planningRequired = planningType !== 'direct_action' && complexity !== 'simple';

      // Map to legacy classification for backwards compatibility
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
          // Legacy fields for backwards compatibility
          classification: legacyClassification,
          confidence,
          originalText: text,

          // Enhanced fields for real planning
          complexity,
          planningType,
          planningRequired,
          capabilities,
          stakeholders,
          constraints,
          dependencies,

          // Analysis metadata
          analyzedAt: Date.now(),
          modelUsed: 'TEXT_SMALL',
        },
      };
    } catch (error) {
      // Fallback to simple rule-based classification if LLM fails
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
          stakeholders: [],
          constraints: [],
          error: (error as Error).message,
          fallback: true,
        },
      };
    }
  },
};

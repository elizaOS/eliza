import { Provider } from '@elizaos/core';

export const messageClassifierProvider: Provider = {
  name: 'messageClassifier',
  description: 'Classifies messages to determine the appropriate strategy action',

  get: async (runtime, message, state) => {
    const text = message.content.text?.toLowerCase() || '';

    let classification = 'general';
    let confidence = 0.5;

    // Simple rule-based classification for demonstration
    if (text.includes('strategy') || text.includes('plan') || text.includes('strategic')) {
      classification = 'strategic';
      confidence = 0.7;
    } else if (text.includes('analyze') || text.includes('analysis')) {
      classification = 'analysis';
      confidence = 0.8;
    } else if (text.includes('process') || text.includes('processing')) {
      classification = 'processing';
      confidence = 0.8;
    } else if (text.includes('execute') || text.includes('final')) {
      classification = 'execution';
      confidence = 0.8;
    }

    return {
      text: `Message classified as: ${classification} with confidence: ${confidence}`,
      data: {
        classification,
        confidence,
        originalText: message.content.text,
      },
    };
  },
};

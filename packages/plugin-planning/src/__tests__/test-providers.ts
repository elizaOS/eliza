import { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';

// Priority detection provider
export const priorityDetectorProvider: Provider = {
  name: 'priorityDetector',
  description: 'Detects priority level from message content',

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const text = message.content.text?.toLowerCase() || '';

    let priority = 'normal';
    let confidence = 0.5;

    if (text.includes('urgent') || text.includes('asap') || text.includes('critical')) {
      priority = 'critical';
      confidence = 0.9;
    } else if (text.includes('high priority') || text.includes('important')) {
      priority = 'high';
      confidence = 0.8;
    } else if (text.includes('low priority') || text.includes('whenever')) {
      priority = 'low';
      confidence = 0.8;
    }

    return {
      text: `Priority level: ${priority}`,
      data: {
        priority,
        confidence,
        indicators:
          text.match(/(urgent|asap|critical|high priority|important|low priority|whenever)/gi) ||
          [],
      },
      values: {
        isPriority: priority !== 'normal',
        priorityLevel: priority,
      },
    };
  },
};

// Capability detector provider
export const capabilityDetectorProvider: Provider = {
  name: 'capabilityDetector',
  description: 'Detects required capabilities from message',
  dynamic: true, // Only runs when explicitly requested

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const text = message.content.text?.toLowerCase() || '';
    const capabilities: string[] = [];

    if (text.includes('analyz') || text.includes('analysis')) {
      capabilities.push('analysis');
    }
    if (text.includes('strateg') || text.includes('plan')) {
      capabilities.push('strategic_planning');
    }
    if (text.includes('research') || text.includes('investigate')) {
      capabilities.push('research');
    }
    if (text.includes('execute') || text.includes('implement')) {
      capabilities.push('execution');
    }

    // Check existing capabilities in state
    const existingCapabilities = state.values?.capabilities || [];
    const missingCapabilities = capabilities.filter((cap) => !existingCapabilities.includes(cap));

    return {
      text:
        capabilities.length > 0
          ? `Required capabilities: ${capabilities.join(', ')}`
          : 'No specific capabilities required',
      data: {
        requiredCapabilities: capabilities,
        existingCapabilities,
        missingCapabilities,
      },
      values: {
        hasAllCapabilities: missingCapabilities.length === 0,
        capabilityGap: missingCapabilities,
      },
    };
  },
};

// Context history provider
export const contextHistoryProvider: Provider = {
  name: 'contextHistory',
  description: 'Provides conversation context history',
  position: -10, // Run early

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Simulate getting conversation history
    const previousMessages = state.data?.conversationHistory || [];
    const messageCount = previousMessages.length;

    // Analyze conversation flow
    const isFollowUp =
      messageCount > 0 &&
      (message.content.text?.toLowerCase().includes('that') ||
        message.content.text?.toLowerCase().includes('it') ||
        message.content.text?.toLowerCase().includes('previous'));

    const topics = previousMessages.map((msg: any) => msg.topic).filter(Boolean);
    const currentTopic = topics[topics.length - 1] || 'general';

    return {
      text: `Conversation context: ${messageCount} previous messages, current topic: ${currentTopic}`,
      data: {
        messageCount,
        isFollowUp,
        currentTopic,
        previousTopics: topics,
      },
      values: {
        hasContext: messageCount > 0,
        conversationDepth: messageCount,
      },
    };
  },
};

// Resource availability provider
export const resourceAvailabilityProvider: Provider = {
  name: 'resourceAvailability',
  description: 'Checks available resources for action execution',
  dynamic: true,

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Simulate checking various resources
    const resources = {
      memory: {
        available: true,
        usage: 0.45, // 45%
      },
      apiQuota: {
        available: true,
        remaining: 1000,
        limit: 5000,
      },
      services: {
        database: true,
        cache: true,
        external_api: Math.random() > 0.1, // 90% availability
      },
      time: {
        businessHours: new Date().getHours() >= 9 && new Date().getHours() < 17,
        peakHours: new Date().getHours() >= 14 && new Date().getHours() < 16,
      },
    };

    const allServicesAvailable = Object.values(resources.services).every((v) => v === true);

    return {
      text: `Resources: Memory ${resources.memory.usage * 100}% used, API quota: ${resources.apiQuota.remaining}/${resources.apiQuota.limit}`,
      data: resources,
      values: {
        resourcesAvailable: allServicesAvailable,
        isBusinessHours: resources.time.businessHours,
        apiQuotaSufficient: resources.apiQuota.remaining > 100,
      },
    };
  },
};

// Sentiment analysis provider
export const sentimentAnalysisProvider: Provider = {
  name: 'sentimentAnalysis',
  description: 'Analyzes sentiment and emotion in messages',

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const text = message.content.text || '';

    // Simple sentiment detection
    const positiveWords = ['good', 'great', 'excellent', 'love', 'happy', 'thanks', 'appreciate'];
    const negativeWords = ['bad', 'terrible', 'hate', 'angry', 'frustrated', 'disappointed'];
    const questionWords = ['what', 'how', 'why', 'when', 'where', 'who', 'which'];

    const words = text.toLowerCase().split(/\s+/);
    const positiveCount = words.filter((w) => positiveWords.includes(w)).length;
    const negativeCount = words.filter((w) => negativeWords.includes(w)).length;
    const questionCount = words.filter((w) => questionWords.includes(w)).length;

    let sentiment = 'neutral';
    let emotion = 'calm';

    if (positiveCount > negativeCount) {
      sentiment = 'positive';
      emotion = positiveCount > 2 ? 'enthusiastic' : 'content';
    } else if (negativeCount > positiveCount) {
      sentiment = 'negative';
      emotion = negativeCount > 2 ? 'upset' : 'concerned';
    }

    const isQuestion = questionCount > 0 || text.includes('?');

    return {
      text: `Sentiment: ${sentiment}, Emotion: ${emotion}${isQuestion ? ', Type: Question' : ''}`,
      data: {
        sentiment,
        emotion,
        scores: {
          positive: positiveCount,
          negative: negativeCount,
          questions: questionCount,
        },
        isQuestion,
      },
      values: {
        sentiment,
        requiresEmpathy: sentiment === 'negative',
        requiresDetailedResponse: isQuestion && questionCount > 1,
      },
    };
  },
};

// Task complexity provider
export const taskComplexityProvider: Provider = {
  name: 'taskComplexity',
  description: 'Estimates task complexity from message',
  private: true, // Must be explicitly included

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const text = message.content.text || '';
    const words = text.split(/\s+/);

    // Complexity indicators
    const complexityFactors = {
      wordCount: words.length,
      hasMultipleSteps: text.includes('and') || text.includes('then') || text.includes('after'),
      hasConditions: text.includes('if') || text.includes('when') || text.includes('unless'),
      hasTechnicalTerms: /API|database|algorithm|integrate|deploy/i.test(text),
      requiresResearch:
        text.includes('research') || text.includes('investigate') || text.includes('find out'),
      requiresCreativity:
        text.includes('create') || text.includes('design') || text.includes('imagine'),
    };

    // Calculate complexity score
    let complexityScore = 0;
    if (complexityFactors.wordCount > 20) complexityScore += 1;
    if (complexityFactors.hasMultipleSteps) complexityScore += 2;
    if (complexityFactors.hasConditions) complexityScore += 1;
    if (complexityFactors.hasTechnicalTerms) complexityScore += 2;
    if (complexityFactors.requiresResearch) complexityScore += 2;
    if (complexityFactors.requiresCreativity) complexityScore += 1;

    const complexity =
      complexityScore <= 2 ? 'simple' : complexityScore <= 5 ? 'moderate' : 'complex';
    const estimatedDuration = complexityScore * 2; // minutes

    return {
      text: `Task complexity: ${complexity}, estimated duration: ${estimatedDuration} minutes`,
      data: {
        complexity,
        complexityScore,
        factors: complexityFactors,
        estimatedDuration,
      },
      values: {
        isComplex: complexity === 'complex',
        requiresPlanning: complexityScore > 3,
        estimatedMinutes: estimatedDuration,
      },
    };
  },
};

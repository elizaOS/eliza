/**
 * Mock LLM client for game tick tests.
 *
 * Avoids hitting real APIs during tests which causes timeouts and flakes.
 * Mocks @feed/engine and overrides only FeedLLMClient.
 */
import { mock } from 'bun:test';

mock.module('@feed/engine', async () => {
  const actualEngine = await import('@feed/engine');

  const createMockClient = () => ({
    getStats: () => ({ provider: 'mock', model: 'mock-model' }),
    getProvider: () => 'mock',
    generateJSON: async (
      _prompt: string,
      schema: { properties?: Record<string, unknown> } | undefined,
      _options?: Record<string, unknown>
    ) => {
      // Handle schema-based detection
      if (schema?.properties) {
        if (schema.properties.question) {
          return {
            question: 'Will testing succeed?',
            resolutionCriteria: 'If tests pass',
          };
        }
        if (schema.properties.npcId) {
          // Market decision mock
          return [
            {
              npcId: 'test-npc',
              npcName: 'Test NPC',
              reasoning: 'Mock reasoning',
              action: 'hold',
              confidence: 0.5,
            },
          ];
        }
        if (schema.properties.title) {
          // Article mock
          return {
            title: 'Mock Article',
            summary: 'This is a mock article summary.',
            article:
              'This is a mock article body.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.',
          };
        }
        if (schema.properties.post) {
          // Post mock
          return {
            post: 'This is a mock post content.',
          };
        }
      }

      // Handle no-schema cases by checking prompt content
      // Check scenario generation first because "MAIN ACTORS:" contains "ACTORS:"
      const isScenarioGeneration =
        _prompt.includes('Create 3 dramatic, satirical scenarios') ||
        (_prompt.includes('MAIN ACTORS:') && _prompt.includes('<scenarios>'));

      if (isScenarioGeneration) {
        return {
          scenarios: [
            {
              id: 1,
              title: 'Test Scenario: Mock Testing',
              description: 'A test scenario for mock testing.',
              mainActors: ['actor-1', 'actor-2', 'actor-3'],
              theme: 'testing',
              involvedOrganizations: [],
            },
          ],
        };
      }

      // Question generation
      const isQuestionGeneration =
        _prompt.includes('prediction market questions') ||
        _prompt.includes('COMPANIES:') ||
        (_prompt.includes('ACTORS:') && !_prompt.includes('MAIN ACTORS:'));

      if (isQuestionGeneration) {
        // Return format matches what XML parser produces (root element unwrapped)
        return {
          questions: [
            {
              id: 1,
              scenario: 1,
              text: 'Will testing succeed?',
              resolutionCriteria: 'If tests complete',
              daysUntilResolution: 3,
              expectedOutcome: 'yes',
              dramaPotential: 7,
              uncertainty: 5,
              satiricalValue: 6,
              observableOutcome: 'Tests pass successfully',
            },
          ],
        };
      }

      return {};
    },
    complete: async () => 'Mock completion response',
  });

  return {
    ...actualEngine,
    FeedLLMClient: {
      forGameTick: createMockClient,
      forGroq: createMockClient,
      forClaude: createMockClient,
      forOpenAI: createMockClient,
    },
  };
});

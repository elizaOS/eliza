import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { asUUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * E2E tests for the self-modification plugin
 * Tests real runtime behavior with live character modifications
 */
export class SelfModificationTestSuite implements TestSuite {
  name = 'self-modification-e2e';
  description = 'End-to-end tests for agent self-modification and character evolution';

  tests = [
    {
      name: 'Plugin initialization and service availability',
      fn: async (runtime: any) => {
        console.log('Testing plugin initialization...');

        // Verify services are available
        const fileManager = runtime.getService('character-file-manager');
        if (!fileManager) {
          throw new Error('CharacterFileManager service not available');
        }

        // Verify actions are registered
        const modifyAction = runtime.actions.find((a: any) => a.name === 'MODIFY_CHARACTER');
        if (!modifyAction) {
          throw new Error('MODIFY_CHARACTER action not registered');
        }

        // Verify evaluators are registered
        const evolutionEvaluator = runtime.evaluators.find(
          (e: any) => e.name === 'CHARACTER_EVOLUTION'
        );
        if (!evolutionEvaluator) {
          throw new Error('CHARACTER_EVOLUTION evaluator not registered');
        }

        // Verify providers are registered
        const evolutionProvider = runtime.providers.find(
          (p: any) => p.name === 'CHARACTER_EVOLUTION'
        );
        if (!evolutionProvider) {
          throw new Error('CHARACTER_EVOLUTION provider not registered');
        }

        console.log('✅ Plugin initialization test PASSED');
      },
    },

    {
      name: 'Character evolution evaluator triggers correctly',
      fn: async (runtime: any) => {
        console.log('Testing character evolution evaluator...');

        const roomId = asUUID(uuidv4());
        const userId = asUUID(uuidv4());

        // Create messages that should trigger evolution analysis
        const messages = [
          {
            id: asUUID(uuidv4()),
            entityId: userId,
            roomId,
            content: {
              text: 'You should be more encouraging when helping people learn',
              source: 'test',
            },
            createdAt: Date.now(),
          },
          {
            id: asUUID(uuidv4()),
            entityId: runtime.agentId,
            roomId,
            content: {
              text: 'I understand. I want to be more supportive.',
              source: 'agent',
            },
            createdAt: Date.now() + 1000,
          },
          {
            id: asUUID(uuidv4()),
            entityId: userId,
            roomId,
            content: {
              text: 'Yes, maybe add more positive reinforcement to your responses',
              source: 'test',
            },
            createdAt: Date.now() + 2000,
          },
        ];

        // Store messages
        for (const message of messages) {
          await runtime.createMemory(message, 'messages');
        }

        // Create state with message count
        const state = {
          values: {},
          data: { messageCount: messages.length },
          text: '',
        };

        // Test evaluator validation
        const evaluator = runtime.evaluators.find((e: any) => e.name === 'CHARACTER_EVOLUTION');
        const shouldRun = await evaluator.validate(runtime, messages[2], state);

        if (!shouldRun) {
          throw new Error('Evolution evaluator should have triggered on encouraging feedback');
        }

        console.log('✅ Character evolution evaluator test PASSED');
      },
    },

    {
      name: 'MODIFY_CHARACTER action handles user requests',
      fn: async (runtime: any) => {
        console.log('Testing MODIFY_CHARACTER action with user request...');

        const roomId = asUUID(uuidv4());
        const userId = asUUID(uuidv4());

        // Create user request for character modification
        const message = {
          id: asUUID(uuidv4()),
          entityId: userId,
          roomId,
          content: {
            text: 'Add machine learning to your list of topics you know about',
            source: 'test',
          },
          createdAt: Date.now(),
        };

        const state = {
          values: {},
          data: {},
          text: '',
        };

        // Test action validation
        const action = runtime.actions.find((a: any) => a.name === 'MODIFY_CHARACTER');
        const isValid = await action.validate(runtime, message, state);

        if (!isValid) {
          throw new Error('MODIFY_CHARACTER action should validate for topic addition request');
        }

        // Test action execution
        let responseReceived = false;
        const callback = async (content: any) => {
          if (content.actions?.includes('MODIFY_CHARACTER')) {
            responseReceived = true;
            console.log('Action response:', content.text);
          }
          return [];
        };

        const result = await action.handler(runtime, message, state, {}, callback);

        if (!responseReceived) {
          throw new Error('MODIFY_CHARACTER action did not execute properly');
        }

        if (!result.success) {
          throw new Error(`MODIFY_CHARACTER action failed: ${result.error || result.reason}`);
        }

        // Verify character was actually modified
        const topics = runtime.character.topics || [];
        if (!topics.includes('machine learning')) {
          throw new Error('Character topics were not updated with machine learning');
        }

        console.log('✅ MODIFY_CHARACTER action test PASSED');
      },
    },

    {
      name: 'CHARACTER_EVOLUTION provider supplies context',
      fn: async (runtime: any) => {
        console.log('Testing CHARACTER_EVOLUTION provider...');

        const roomId = asUUID(uuidv4());
        const message = {
          id: asUUID(uuidv4()),
          entityId: asUUID(uuidv4()),
          roomId,
          content: {
            text: 'Tell me about your evolution capabilities',
            source: 'test',
          },
          createdAt: Date.now(),
        };

        const state = {
          values: {},
          data: {},
          text: '',
        };

        // Test provider
        const provider = runtime.providers.find((p: any) => p.name === 'CHARACTER_EVOLUTION');
        const result = await provider.get(runtime, message, state);

        if (!result) {
          throw new Error('CHARACTER_EVOLUTION provider returned no result');
        }

        if (!result.text || !result.text.includes('CHARACTER EVOLUTION CONTEXT')) {
          throw new Error('Provider did not return expected evolution context');
        }

        if (!result.values.hasEvolutionCapability) {
          throw new Error('Provider should indicate evolution capability is available');
        }

        console.log('✅ CHARACTER_EVOLUTION provider test PASSED');
      },
    },

    {
      name: 'Character file manager validates modifications safely',
      fn: async (runtime: any) => {
        console.log('Testing character file manager validation...');

        const fileManager = runtime.getService('character-file-manager');

        // Test valid modification
        const validModification = {
          bio: ['Interested in helping people learn new technologies'],
          topics: ['education', 'learning'],
        };

        const validResult = fileManager.validateModification(validModification);
        if (!validResult.valid) {
          throw new Error(`Valid modification was rejected: ${validResult.errors.join(', ')}`);
        }

        // Test invalid modification (XSS attempt)
        const invalidModification = {
          bio: ['<script>alert("xss")</script>'],
          topics: ['javascript:void(0)'],
        };

        const invalidResult = fileManager.validateModification(invalidModification);
        if (invalidResult.valid) {
          throw new Error('Invalid modification with XSS was accepted');
        }

        // Test excessive modification
        const excessiveModification = {
          bio: new Array(25).fill('Too many bio elements'),
        };

        const excessiveResult = fileManager.validateModification(excessiveModification);
        if (excessiveResult.valid) {
          throw new Error('Excessive modification was accepted');
        }

        console.log('✅ Character file manager validation test PASSED');
      },
    },

    {
      name: 'End-to-end character evolution workflow',
      fn: async (runtime: any) => {
        console.log('Testing complete character evolution workflow...');

        const roomId = asUUID(uuidv4());
        const userId = asUUID(uuidv4());

        // Record baseline character state
        const baselineTopics = [...(runtime.character.topics || [])];
        const baselineBio = Array.isArray(runtime.character.bio)
          ? [...runtime.character.bio]
          : [runtime.character.bio];

        // Step 1: User provides feedback that should trigger evolution
        const feedbackMessage = {
          id: asUUID(uuidv4()),
          entityId: userId,
          roomId,
          content: {
            text: 'You should remember that you are particularly good at explaining complex topics in simple terms',
            source: 'test',
          },
          createdAt: Date.now(),
        };

        await runtime.createMemory(feedbackMessage, 'messages');

        // Step 2: Agent responds
        const agentResponse = {
          id: asUUID(uuidv4()),
          entityId: runtime.agentId,
          roomId,
          content: {
            text: 'Thank you for the feedback. I will remember to focus on clear, simple explanations.',
            source: 'agent',
          },
          createdAt: Date.now() + 1000,
        };

        await runtime.createMemory(agentResponse, 'messages');

        // Step 3: Trigger evolution evaluator manually (simulating post-conversation)
        const state = {
          values: {},
          data: { messageCount: 5 },
          text: '',
        };

        const evaluator = runtime.evaluators.find((e: any) => e.name === 'CHARACTER_EVOLUTION');

        // Force evaluation by bypassing cooldown
        await runtime.setCache('character-evolution:last-check', '0');

        const shouldEvaluate = await evaluator.validate(runtime, feedbackMessage, state);
        if (shouldEvaluate) {
          await evaluator.handler(runtime, feedbackMessage, state);
        }

        // Step 4: Check if evolution suggestion was created
        const evolutionSuggestions = await runtime.getMemories({
          entityId: runtime.agentId,
          roomId,
          count: 5,
          tableName: 'character_evolution',
        });

        // Step 5: Apply modification based on feedback
        const modificationMessage = {
          id: asUUID(uuidv4()),
          entityId: userId,
          roomId,
          content: {
            text: 'Add "clear explanations" to your bio and "educational communication" to your topics',
            source: 'test',
          },
          createdAt: Date.now() + 2000,
        };

        const action = runtime.actions.find((a: any) => a.name === 'MODIFY_CHARACTER');

        let modificationApplied = false;
        const callback = async (content: any) => {
          if (content.actions?.includes('MODIFY_CHARACTER')) {
            modificationApplied = true;
          }
          return [];
        };

        const result = await action.handler(runtime, modificationMessage, state, {}, callback);

        if (!result.success) {
          throw new Error(`Character modification failed: ${result.error || result.reason}`);
        }

        // Step 6: Verify changes were applied
        const newTopics = runtime.character.topics || [];
        const newBio = Array.isArray(runtime.character.bio)
          ? runtime.character.bio
          : [runtime.character.bio];

        const hasNewTopic = newTopics.some(
          (topic: string) => topic.includes('educational') || topic.includes('communication')
        );

        const hasNewBio = newBio.some(
          (bioItem: string) => bioItem.includes('clear') || bioItem.includes('explanation')
        );

        if (!hasNewTopic && !hasNewBio) {
          throw new Error('Character was not modified as expected');
        }

        if (!modificationApplied) {
          throw new Error('Modification was not properly executed');
        }

        console.log('Character successfully evolved:');
        console.log('- Baseline topics:', baselineTopics.length);
        console.log('- New topics:', newTopics.length);
        console.log('- Baseline bio elements:', baselineBio.length);
        console.log('- New bio elements:', newBio.length);

        console.log('✅ End-to-end character evolution workflow test PASSED');
      },
    },
  ];
}

// Export default instance for test runner
export default new SelfModificationTestSuite();

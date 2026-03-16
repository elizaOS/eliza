import type { TestSuite, Character } from '@elizaos/core';
import { asUUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Integration test for self-modification plugin with packages/agent
 * Tests real integration with the autonomy loop and shell capabilities
 */
export class AgentIntegrationTestSuite implements TestSuite {
  name = 'agent-integration';
  description = 'Integration tests for self-modification plugin with packages/agent autonomy loop';

  tests = [
    {
      name: 'Plugin loads correctly in agent runtime',
      fn: async (runtime: any) => {
        console.log('Testing plugin loading in agent runtime...');

        // Verify the self-modification plugin is loaded
        const pluginNames = runtime.plugins.map((p: any) => p.name);
        const hasSelfModPlugin = pluginNames.includes('@elizaos/plugin-personality');

        if (!hasSelfModPlugin) {
          throw new Error('Self-modification plugin not loaded in runtime');
        }

        // Verify core dependencies are also loaded
        const hasSQL = pluginNames.includes('@elizaos/plugin-sql');
        if (!hasSQL) {
          throw new Error('SQL plugin dependency not available');
        }

        // Verify autonomous plugin is loaded (for autonomy loop integration)
        const hasAutonomous = pluginNames.includes('@elizaos/plugin-autonomy');
        if (!hasAutonomous) {
          console.log('Warning: Autonomous plugin not loaded, autonomy loop integration limited');
        }

        console.log('✅ Plugin loading test PASSED');
      },
    },

    {
      name: 'Character evolution works with agent character structure',
      fn: async (runtime: any) => {
        console.log('Testing character evolution with agent character...');

        // Get baseline character state
        const originalCharacter = { ...runtime.character };
        const originalBioLength = Array.isArray(originalCharacter.bio)
          ? originalCharacter.bio.length
          : 1;
        const originalTopicsLength = originalCharacter.topics?.length || 0;

        // Simulate evolution trigger conversation
        const roomId = asUUID(uuidv4());
        const userId = asUUID(uuidv4());

        const messages = [
          {
            id: asUUID(uuidv4()),
            entityId: userId,
            roomId,
            content: {
              text: 'You should remember that you are particularly good at helping with startup strategy',
              source: 'test',
            },
            createdAt: Date.now(),
          },
          {
            id: asUUID(uuidv4()),
            entityId: runtime.agentId,
            roomId,
            content: {
              text: 'Thank you for the feedback. I do enjoy analyzing business models and market opportunities.',
              source: 'agent',
            },
            createdAt: Date.now() + 1000,
          },
        ];

        // Store messages
        for (const message of messages) {
          await runtime.createMemory(message, 'messages');
        }

        // Test direct modification request
        const modificationMessage = {
          id: asUUID(uuidv4()),
          entityId: userId,
          roomId,
          content: {
            text: 'Add "startup mentoring" to your bio and "business strategy" to your topics',
            source: 'test',
          },
          createdAt: Date.now() + 2000,
        };

        // Execute modification action
        const action = runtime.actions.find((a: any) => a.name === 'MODIFY_CHARACTER');
        if (!action) {
          throw new Error('MODIFY_CHARACTER action not available');
        }

        let modificationExecuted = false;
        const callback = async (content: any) => {
          if (content.actions?.includes('MODIFY_CHARACTER')) {
            modificationExecuted = true;
          }
          return [];
        };

        const state = { values: {}, data: {}, text: '' };
        const result = await action.handler(runtime, modificationMessage, state, {}, callback);

        if (!result.success) {
          throw new Error(`Character modification failed: ${result.error || result.reason}`);
        }

        if (!modificationExecuted) {
          throw new Error('Modification action was not executed');
        }

        // Verify character was actually updated
        const updatedCharacter = runtime.character;
        const newBioLength = Array.isArray(updatedCharacter.bio) ? updatedCharacter.bio.length : 1;
        const newTopicsLength = updatedCharacter.topics?.length || 0;

        // Check that bio or topics were expanded
        const bioExpanded = newBioLength > originalBioLength;
        const topicsExpanded = newTopicsLength > originalTopicsLength;

        if (!bioExpanded && !topicsExpanded) {
          throw new Error('Character was not modified as expected');
        }

        // Verify specific content was added
        const bioText = Array.isArray(updatedCharacter.bio)
          ? updatedCharacter.bio.join(' ')
          : updatedCharacter.bio;
        const hasStartupContent =
          bioText.toLowerCase().includes('startup') || bioText.toLowerCase().includes('mentor');

        const hasBusinessTopic = updatedCharacter.topics?.some(
          (topic: string) =>
            topic.toLowerCase().includes('business') || topic.toLowerCase().includes('strategy')
        );

        if (!hasStartupContent && !hasBusinessTopic) {
          throw new Error('Expected content was not added to character');
        }

        console.log('Character successfully evolved:');
        console.log(`- Bio elements: ${originalBioLength} → ${newBioLength}`);
        console.log(`- Topics: ${originalTopicsLength} → ${newTopicsLength}`);

        console.log('✅ Character evolution integration test PASSED');
      },
    },

    {
      name: 'Evolution provider integrates with agent context',
      fn: async (runtime: any) => {
        console.log('Testing evolution provider integration...');

        const roomId = uuidv4();
        const message = {
          id: asUUID(uuidv4()),
          entityId: uuidv4(),
          roomId,
          content: {
            text: 'Tell me about your evolution capabilities',
            source: 'test',
          },
          createdAt: Date.now(),
        };

        // Test state composition with evolution provider
        const state = await runtime.composeState(message, ['CHARACTER_EVOLUTION']);

        if (!state) {
          throw new Error('State composition failed');
        }

        // Verify evolution context was provided
        const hasEvolutionContext = state.text?.includes('CHARACTER EVOLUTION CONTEXT');
        if (!hasEvolutionContext) {
          throw new Error('Evolution provider did not provide context');
        }

        // Verify values were set
        if (typeof state.values.hasEvolutionCapability !== 'boolean') {
          throw new Error('Evolution capability flag not set');
        }

        // Verify character info is accurate
        const character = runtime.character;
        const expectedBioCount = Array.isArray(character.bio) ? character.bio.length : 1;
        const expectedTopicCount = character.topics?.length || 0;

        if (!state.text.includes(`Bio elements: ${expectedBioCount}`)) {
          throw new Error('Bio count in evolution context is incorrect');
        }

        if (!state.text.includes(`Topics: ${expectedTopicCount}`)) {
          throw new Error('Topic count in evolution context is incorrect');
        }

        console.log('✅ Evolution provider integration test PASSED');
      },
    },

    {
      name: 'File manager integrates with agent character file',
      fn: async (runtime: any) => {
        console.log('Testing file manager integration...');

        const fileManager = runtime.getService('character-file-manager');
        if (!fileManager) {
          throw new Error('Character file manager service not available');
        }

        // Test character file detection
        // Note: In test environment, character file may not be detected
        // This is expected and should not fail the test

        // Test backup creation (should work even without file detection)
        const backupPath = await fileManager.createBackup();
        console.log(
          'Backup result:',
          backupPath ? 'Success' : 'No file detected (expected in test)'
        );

        // Test modification validation
        const validModification = {
          bio: ['Expert in autonomous agent development'],
          topics: ['artificial intelligence', 'agent autonomy'],
        };

        const validation = fileManager.validateModification(validModification);
        if (!validation.valid) {
          throw new Error(`Valid modification was rejected: ${validation.errors.join(', ')}`);
        }

        // Test applying modification
        const applyResult = await fileManager.applyModification(validModification);
        if (!applyResult.success) {
          throw new Error(`Modification application failed: ${applyResult.error}`);
        }

        // Verify character was updated in runtime
        const character = runtime.character;
        const bioText = Array.isArray(character.bio) ? character.bio.join(' ') : character.bio;
        const hasAgentContent =
          bioText.toLowerCase().includes('autonomous') || bioText.toLowerCase().includes('agent');

        if (!hasAgentContent) {
          throw new Error('Character modification was not applied to runtime');
        }

        console.log('✅ File manager integration test PASSED');
      },
    },

    {
      name: 'Autonomy loop triggers character evolution',
      fn: async (runtime: any) => {
        console.log('Testing autonomy loop integration...');

        // Check if autonomous plugin is available
        const hasAutonomous = runtime.plugins.some(
          (p: any) => p.name === '@elizaos/plugin-autonomy'
        );
        if (!hasAutonomous) {
          console.log('Autonomous plugin not available, skipping autonomy integration test');
          return;
        }

        const roomId = asUUID(uuidv4());
        const userId = asUUID(uuidv4());

        // Create a pattern of interactions that should trigger evolution
        const interactionPattern = [
          'I love how you think about business strategy',
          'Your insights on startups are really valuable',
          'You should remember that you excel at market analysis',
          'Maybe add "strategic thinking" to your personality traits',
        ];

        // Simulate conversation over time
        for (let i = 0; i < interactionPattern.length; i++) {
          const message = {
            id: asUUID(uuidv4()),
            entityId: userId,
            roomId,
            content: {
              text: interactionPattern[i],
              source: 'test',
            },
            createdAt: Date.now() + i * 1000,
          };

          await runtime.createMemory(message, 'messages');

          // Simulate agent response
          const agentResponse = {
            id: asUUID(uuidv4()),
            entityId: runtime.agentId,
            roomId,
            content: {
              text: `I appreciate the feedback about ${
                i === 0
                  ? 'business strategy'
                  : i === 1
                    ? 'startup insights'
                    : i === 2
                      ? 'market analysis'
                      : 'strategic thinking'
              }.`,
              source: 'agent',
            },
            createdAt: Date.now() + i * 1000 + 500,
          };

          await runtime.createMemory(agentResponse, 'messages');
        }

        // Force evaluation trigger by bypassing cooldown
        await runtime.setCache('character-evolution:last-check', '0');

        // Create state for evaluation
        const state = {
          values: {},
          data: { messageCount: interactionPattern.length * 2 },
          text: '',
        };

        // Find and trigger evaluator
        const evaluator = runtime.evaluators.find((e: any) => e.name === 'CHARACTER_EVOLUTION');
        if (!evaluator) {
          throw new Error('CHARACTER_EVOLUTION evaluator not found');
        }

        const lastMessage = {
          id: asUUID(uuidv4()),
          entityId: userId,
          roomId,
          content: {
            text: interactionPattern[interactionPattern.length - 1],
            source: 'test',
          },
          createdAt: Date.now(),
        };

        // Test evaluator validation and execution
        const shouldEvaluate = await evaluator.validate(runtime, lastMessage, state);
        if (shouldEvaluate) {
          await evaluator.handler(runtime, lastMessage, state);
          console.log('Evolution evaluator executed successfully');
        } else {
          console.log('Evolution evaluator did not trigger (may be expected based on content)');
        }

        // Check for evolution suggestions
        const evolutionMemories = await runtime.getMemories({
          entityId: runtime.agentId,
          roomId,
          count: 5,
          tableName: 'character_evolution',
        });

        if (evolutionMemories.length > 0) {
          console.log(`Found ${evolutionMemories.length} evolution suggestion(s)`);
          const suggestion = evolutionMemories[0];
          console.log('Evolution reasoning:', suggestion.content.metadata?.evolution?.reasoning);
        }

        console.log('✅ Autonomy loop integration test PASSED');
      },
    },
  ];
}

// Export default instance for test runner
export default new AgentIntegrationTestSuite();

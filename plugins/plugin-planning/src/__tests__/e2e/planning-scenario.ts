import type { IAgentRuntime, Memory, TestSuite, UUID } from '@elizaos/core';
import { ChannelType, EventType } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { PlanningService } from '../../services/planning-service';

/**
 * Real ElizaOS E2E Tests for Planning Plugin
 * Uses actual runtime instances and real LLM integration
 */
export const planningScenariosSuite: TestSuite = {
  name: 'Planning Plugin E2E Scenarios',
  tests: [
    {
      name: 'Should create and execute simple plans with real runtime',
      fn: async (runtime: IAgentRuntime) => {
        // Verify planning service is available
        const planningService = runtime.getService<PlanningService>('planning');
        if (!planningService) {
          throw new Error('Planning service not available in runtime');
        }

        // Create real memory with planning request
        const roomId = uuidv4() as UUID;
        const userId = uuidv4() as UUID;

        const message: Memory = {
          id: uuidv4() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: 'Create a plan to analyze customer feedback and generate a response',
            source: 'test',
            actions: ['CREATE_PLAN', 'EXECUTE_PLAN'],
          },
          createdAt: Date.now(),
        };

        await runtime.createMemory(message, 'messages');

        // Create real state using runtime
        const state = await runtime.composeState(message, ['messageClassifier']);

        // Create simple plan using planning service
        const responseContent = {
          text: 'I will create a plan to analyze the feedback',
          actions: ['ANALYZE_INPUT', 'PROCESS_ANALYSIS', 'EXECUTE_FINAL'],
        };

        const plan = await planningService.createSimplePlan(
          runtime,
          message,
          state,
          responseContent
        );

        if (!plan) {
          throw new Error('Failed to create simple plan');
        }

        // Validate plan structure
        if (plan.steps.length !== 3) {
          throw new Error(`Expected 3 steps, got ${plan.steps.length}`);
        }

        // Verify plan contains expected actions
        const actionNames = plan.steps.map((s) => s.actionName);
        if (!actionNames.includes('ANALYZE_INPUT')) {
          throw new Error('Plan missing ANALYZE_INPUT action');
        }

        console.log('✅ Simple plan creation test passed');
      },
    },

    {
      name: 'Should create comprehensive plans using real LLM',
      fn: async (runtime: IAgentRuntime) => {
        const planningService = runtime.getService<PlanningService>('planning');
        if (!planningService) {
          throw new Error('Planning service not available');
        }

        // Create comprehensive planning context
        const context = {
          goal: 'Develop a customer retention strategy based on feedback analysis',
          constraints: [
            {
              type: 'time' as const,
              value: '2 weeks',
              description: 'Must complete within 2 weeks',
            },
            {
              type: 'resource' as const,
              value: 'limited',
              description: 'Limited budget available',
            },
          ],
          availableActions: runtime.actions.map((a) => a.name),
          availableProviders: runtime.providers.map((p) => p.name),
          preferences: {
            executionModel: 'sequential' as const,
            maxSteps: 5,
            timeoutMs: 30000,
          },
        };

        // Use real LLM to create comprehensive plan
        const comprehensivePlan = await planningService.createComprehensivePlan(runtime, context);

        // Validate plan using planning service
        const validation = await planningService.validatePlan(runtime, comprehensivePlan);
        if (!validation.valid) {
          throw new Error(`Plan validation failed: ${validation.issues?.join(', ')}`);
        }

        // Verify plan has reasonable number of steps
        if (comprehensivePlan.steps.length < 2 || comprehensivePlan.steps.length > 8) {
          throw new Error(`Unexpected step count: ${comprehensivePlan.steps.length}`);
        }

        // Verify all actions exist in runtime
        for (const step of comprehensivePlan.steps) {
          const action = runtime.actions.find((a) => a.name === step.actionName);
          if (!action) {
            throw new Error(`Action '${step.actionName}' not found in runtime`);
          }
        }

        console.log(
          `✅ Comprehensive plan creation test passed with ${comprehensivePlan.steps.length} steps`
        );
      },
    },

    {
      name: 'Should execute plans with real runtime integration',
      fn: async (runtime: IAgentRuntime) => {
        const planningService = runtime.getService<PlanningService>('planning');
        if (!planningService) {
          throw new Error('Planning service not available');
        }

        // Create test room and user
        const roomId = uuidv4() as UUID;
        const userId = uuidv4() as UUID;

        // Ensure room exists
        await runtime.ensureRoomExists({
          id: roomId,
          source: 'test',
          type: ChannelType.GROUP,
        });

        const message: Memory = {
          id: uuidv4() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: 'Execute a simple two-step process',
            source: 'test',
          },
          createdAt: Date.now(),
        };

        await runtime.createMemory(message, 'messages');

        // Create a simple plan for execution
        const simplePlan = {
          id: uuidv4() as UUID,
          goal: 'Execute test workflow',
          steps: [
            {
              id: uuidv4() as UUID,
              actionName: 'REPLY',
              parameters: { text: 'Step 1 executing' },
              dependencies: [],
            },
            {
              id: uuidv4() as UUID,
              actionName: 'REPLY',
              parameters: { text: 'Step 2 executing' },
              dependencies: [],
            },
          ],
          executionModel: 'sequential' as const,
          state: { status: 'pending' as const },
          metadata: {
            createdAt: Date.now(),
            estimatedDuration: 10000,
            priority: 1,
            tags: ['test'],
          },
        };

        // Execute plan using real runtime
        const executionResult = await planningService.executePlan(runtime, simplePlan, message);

        // Verify execution results
        if (!executionResult.success) {
          throw new Error(
            `Plan execution failed: ${executionResult.errors?.map((e) => e.message).join(', ')}`
          );
        }

        if (executionResult.completedSteps !== 2) {
          throw new Error(`Expected 2 completed steps, got ${executionResult.completedSteps}`);
        }

        if (executionResult.results.length !== 2) {
          throw new Error(`Expected 2 results, got ${executionResult.results.length}`);
        }

        console.log(`✅ Plan execution test passed in ${executionResult.duration}ms`);
      },
    },

    {
      name: 'Should integrate with message handling system',
      fn: async (runtime: IAgentRuntime) => {
        // Test that planning service integrates with message processing
        const roomId = uuidv4() as UUID;
        const userId = uuidv4() as UUID;

        await runtime.ensureRoomExists({
          id: roomId,
          source: 'test',
          type: ChannelType.DM,
        });

        // Create message that should trigger planning
        const planningMessage: Memory = {
          id: uuidv4() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: 'I need you to analyze data, create a report, and email it to stakeholders',
            source: 'test',
          },
          createdAt: Date.now(),
        };

        await runtime.createMemory(planningMessage, 'messages');

        // Process message through runtime (this should use planning service)
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, planningMessage);

        // Wait for processing to complete
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Retrieve response messages
        const messages = await runtime.getMemories({
          roomId,
          count: 10,
          tableName: 'messages',
        });

        // Should have at least the original message plus agent response
        if (messages.length < 2) {
          throw new Error(`Expected at least 2 messages, got ${messages.length}`);
        }

        // Find agent response
        const agentResponse = messages.find(
          (m) => m.entityId === runtime.agentId && m.id !== planningMessage.id
        );

        if (!agentResponse) {
          throw new Error('No agent response found');
        }

        if (!agentResponse.content.text) {
          throw new Error('Agent response has no text content');
        }

        console.log('✅ Message handling integration test passed');
        console.log(`Agent response: ${agentResponse.content.text}`);
      },
    },

    {
      name: 'Should handle plan adaptation and error recovery',
      fn: async (runtime: IAgentRuntime) => {
        const planningService = runtime.getService<PlanningService>('planning');
        if (!planningService) {
          throw new Error('Planning service not available');
        }

        // Create a plan that will encounter issues
        const problematicPlan = {
          id: uuidv4() as UUID,
          goal: 'Test error handling and adaptation',
          steps: [
            {
              id: uuidv4() as UUID,
              actionName: 'NONEXISTENT_ACTION', // This will fail
              parameters: {},
              dependencies: [],
            },
            {
              id: uuidv4() as UUID,
              actionName: 'REPLY',
              parameters: { text: 'Recovery step' },
              dependencies: [],
            },
          ],
          executionModel: 'sequential' as const,
          state: { status: 'pending' as const },
          metadata: {
            createdAt: Date.now(),
            estimatedDuration: 5000,
            priority: 1,
            tags: ['error-test'],
          },
        };

        // Validate plan (should catch the missing action)
        const validation = await planningService.validatePlan(runtime, problematicPlan);
        if (validation.valid) {
          throw new Error('Plan validation should have failed for nonexistent action');
        }

        if (!validation.issues?.some((issue) => issue.includes('NONEXISTENT_ACTION'))) {
          throw new Error('Validation should have flagged the nonexistent action');
        }

        // Test adaptation
        const adaptedPlan = await planningService.adaptPlan(
          runtime,
          problematicPlan,
          0, // Current step index
          [], // No previous results
          new Error('Action not found')
        );

        // Verify adaptation occurred
        if (adaptedPlan.id !== problematicPlan.id) {
          throw new Error('Adapted plan should maintain same ID');
        }

        if (!adaptedPlan.metadata.adaptations) {
          throw new Error('Adapted plan should have adaptation metadata');
        }

        console.log('✅ Plan adaptation and error recovery test passed');
      },
    },
  ],
};

export default planningScenariosSuite;

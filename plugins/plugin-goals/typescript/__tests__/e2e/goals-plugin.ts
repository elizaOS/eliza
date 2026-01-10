import { logger, TestSuite, createMessageMemory, type UUID } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';

export const GoalsPluginE2ETestSuite: TestSuite = {
  name: 'Goals Plugin E2E Tests',
  tests: [
    {
      name: 'should create and complete a goal successfully',
      fn: async (runtime: IAgentRuntime) => {
        logger.info('Testing goal creation and completion flow...');

        const { createGoalDataService } = await import('../../services/goalDataService');
        const dataService = createGoalDataService(runtime);

        // Create test data
        const testEntityId = `test-entity-${Date.now()}` as UUID;

        // Create a goal
        const goalName = `Test Goal ${Date.now()}`;
        const createdGoalId = await dataService.createGoal({
          agentId: runtime.agentId,
          ownerType: 'entity',
          ownerId: testEntityId,
          name: goalName,
          description: 'Test goal description',
          metadata: {},
          tags: ['test'],
        });

        if (!createdGoalId) {
          throw new Error('Failed to create goal');
        }
        logger.info(`✓ Goal created with ID: ${createdGoalId}`);

        // Verify goal was created
        const goal = await dataService.getGoal(createdGoalId);
        if (!goal) {
          throw new Error('Created goal not found');
        }
        if (goal.name !== goalName) {
          throw new Error(`Goal name mismatch. Expected: ${goalName}, Got: ${goal.name}`);
        }
        if (goal.isCompleted) {
          throw new Error('New goal should not be completed');
        }
        logger.info('✓ Goal retrieved and verified');

        // Complete the goal
        await dataService.updateGoal(createdGoalId, {
          isCompleted: true,
          completedAt: new Date(),
        });

        // Verify completion
        const completedGoal = await dataService.getGoal(createdGoalId);
        if (!completedGoal?.isCompleted) {
          throw new Error('Goal should be marked as completed');
        }
        logger.info('✓ Goal marked as completed');

        // Clean up
        await dataService.deleteGoal(createdGoalId);
        logger.info('✅ Goal creation and completion flow successful');
      },
    },
    {
      name: 'should get uncompleted goals correctly',
      fn: async (runtime: IAgentRuntime) => {
        logger.info('Testing uncompleted goals retrieval...');

        const { createGoalDataService } = await import('../../services/goalDataService');
        const dataService = createGoalDataService(runtime);

        // Create test data
        const testEntityId = `test-entity-${Date.now()}` as UUID;

        // Create multiple goals
        const goal1Id = await dataService.createGoal({
          agentId: runtime.agentId,
          ownerType: 'entity',
          ownerId: testEntityId,
          name: 'Active Goal 1',
          metadata: {},
          tags: ['test'],
        });

        const goal2Id = await dataService.createGoal({
          agentId: runtime.agentId,
          ownerType: 'entity',
          ownerId: testEntityId,
          name: 'Active Goal 2',
          metadata: {},
          tags: ['test'],
        });

        logger.info('✓ Created two active goals');

        // Get uncompleted goals
        const uncompletedGoals = await dataService.getUncompletedGoals('entity', testEntityId);

        if (uncompletedGoals.length !== 2) {
          throw new Error(`Expected 2 uncompleted goals, got ${uncompletedGoals.length}`);
        }
        logger.info('✓ Retrieved correct number of uncompleted goals');

        // Complete one goal
        await dataService.updateGoal(goal1Id!, {
          isCompleted: true,
          completedAt: new Date(),
        });

        // Check uncompleted goals again
        const remainingGoals = await dataService.getUncompletedGoals('entity', testEntityId);
        if (remainingGoals.length !== 1) {
          throw new Error(`Expected 1 uncompleted goal, got ${remainingGoals.length}`);
        }
        logger.info('✓ Uncompleted goals updated correctly after completion');

        // Clean up
        if (goal1Id) await dataService.deleteGoal(goal1Id);
        if (goal2Id) await dataService.deleteGoal(goal2Id);
        logger.info('✅ Uncompleted goals retrieval successful');
      },
    },
    {
      name: 'should filter goals by tags correctly',
      fn: async (runtime: IAgentRuntime) => {
        logger.info('Testing goal tag filtering...');

        const { createGoalDataService } = await import('../../services/goalDataService');
        const dataService = createGoalDataService(runtime);

        // Create test data
        const testEntityId = `test-entity-${Date.now()}` as UUID;

        // Create goals with different tags
        const workGoalId = await dataService.createGoal({
          agentId: runtime.agentId,
          ownerType: 'entity',
          ownerId: testEntityId,
          name: 'Work Goal',
          metadata: {},
          tags: ['work', 'important'],
        });

        const personalGoalId = await dataService.createGoal({
          agentId: runtime.agentId,
          ownerType: 'entity',
          ownerId: testEntityId,
          name: 'Personal Goal',
          metadata: {},
          tags: ['personal', 'health'],
        });

        logger.info('✓ Created goals with different tags');

        // Filter by 'work' tag
        const workGoals = await dataService.getGoals({
          ownerType: 'entity',
          ownerId: testEntityId,
          tags: ['work'],
        });

        if (workGoals.length !== 1) {
          throw new Error(`Expected 1 work goal, got ${workGoals.length}`);
        }
        if (workGoals[0].name !== 'Work Goal') {
          throw new Error('Wrong goal returned for work tag filter');
        }
        logger.info('✓ Tag filtering working correctly');

        // Clean up
        if (workGoalId) await dataService.deleteGoal(workGoalId);
        if (personalGoalId) await dataService.deleteGoal(personalGoalId);
        logger.info('✅ Goal tag filtering successful');
      },
    },
    {
      name: 'should process CREATE_GOAL action correctly',
      fn: async (runtime: IAgentRuntime) => {
        logger.info('Testing CREATE_GOAL action...');

        // Find the action
        const createAction = runtime.actions.find((a) => a.name === 'CREATE_GOAL');
        if (!createAction) {
          throw new Error('CREATE_GOAL action not found');
        }
        logger.info('✓ CREATE_GOAL action found');

        // Create test message
        const testRoomId = `test-room-${Date.now()}` as UUID;
        const testEntityId = `test-entity-${Date.now()}` as UUID;
        const testMessage = createMessageMemory({
          entityId: testEntityId,
          agentId: runtime.agentId,
          roomId: testRoomId,
          content: {
            text: 'I want to set a goal to learn Spanish',
            source: 'test',
          },
        });

        // Validate the action
        const isValid = await createAction.validate(runtime, testMessage);
        if (!isValid) {
          throw new Error('CREATE_GOAL action validation failed');
        }
        logger.info('✓ CREATE_GOAL action validated');

        logger.info('✅ CREATE_GOAL action test completed');
      },
    },
  ],
};

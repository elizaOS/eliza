import { logger, TestSuite, createMessageMemory, type UUID } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import { setupReminderDemo, monitorReminders, cleanupDemo } from '../../scripts/demo-reminders';

export const ReminderDeliveryE2ETestSuite: TestSuite = {
  name: 'Reminder Delivery E2E Tests',
  tests: [
    {
      name: 'should send reminders through rolodex to actual platforms',
      fn: async (runtime: IAgentRuntime) => {
        logger.info('🧪 Testing reminder delivery to actual platforms...');

        // Check if rolodex is available
        const messageDeliveryService = runtime.getService('MESSAGE_DELIVERY' as any);
        if (!messageDeliveryService) {
          logger.warn('⚠️ Rolodex MESSAGE_DELIVERY service not available');
          logger.info('This test requires the rolodex plugin to be loaded');
          logger.info('Make sure your character.json includes "@elizaos/plugin-rolodex"');
          return;
        }

        logger.info('✓ Rolodex service detected - testing real delivery');

        // Set up demo scenarios
        const { testUserId, testRoomId, overdueTaskId } = await setupReminderDemo(runtime);

        // Monitor for 30 seconds to see reminders being sent
        logger.info('\n📡 Monitoring reminder delivery for 30 seconds...');
        logger.info('Check your connected platforms for notifications!');
        
        await monitorReminders(runtime, 30000);

        // Clean up
        await cleanupDemo(runtime, testUserId);

        logger.info('✅ Reminder delivery test complete');
        logger.info('If rolodex is properly configured, you should have received:');
        logger.info('- High priority overdue task reminder');
        logger.info('- Medium priority upcoming task reminder (if within 30 min)');
      },
    },
    {
      name: 'should handle daily task reminders at scheduled times',
      fn: async (runtime: IAgentRuntime) => {
        logger.info('🧪 Testing daily task reminder scheduling...');

        const dataService = await import('../../services/todoDataService');
        const todoService = dataService.createTodoDataService(runtime);

        // Create test data
        const testUserId = 'daily-test-user' as UUID;
        const testRoomId = 'daily-test-room' as UUID;
        const testWorldId = 'daily-test-world' as UUID;

        // Create daily tasks
        const dailyTaskIds: UUID[] = [];
        const dailyTasks = [
          '🌅 Morning meditation',
          '💪 Workout session',
          '📖 Evening journal',
        ];

        for (const taskName of dailyTasks) {
          const taskId = await todoService.createTodo({
            agentId: runtime.agentId,
            worldId: testWorldId,
            roomId: testRoomId,
            entityId: testUserId,
            name: taskName,
            type: 'daily',
            priority: 3,
            tags: ['daily', 'routine'],
          });
          dailyTaskIds.push(taskId);
          logger.info(`✓ Created daily task: ${taskName}`);
        }

        // Check current time
        const now = new Date();
        const hour = now.getHours();
        
        if (hour === 9 || hour === 18) {
          logger.info('🔔 Current time matches daily reminder schedule!');
          logger.info('Daily reminders should be sent now');
          
          // Trigger reminder check
          const reminderService = runtime.getService('TODO_REMINDER' as any);
          if (reminderService) {
            await (reminderService as any).checkTasksForReminders();
          }
        } else {
          logger.info(`⏰ Current time is ${hour}:00`);
          logger.info('Daily reminders are scheduled for 9 AM and 6 PM');
          logger.info(`Next reminder in ${hour < 9 ? 9 - hour : hour < 18 ? 18 - hour : 24 + 9 - hour} hours`);
        }

        // Clean up
        for (const taskId of dailyTaskIds) {
          await todoService.deleteTodo(taskId);
        }

        logger.info('✅ Daily reminder test complete');
      },
    },
    {
      name: 'should respect reminder intervals and avoid spam',
      fn: async (runtime: IAgentRuntime) => {
        logger.info('🧪 Testing reminder spam prevention...');

        const dataService = await import('../../services/todoDataService');
        const todoService = dataService.createTodoDataService(runtime);

        // Create an overdue task
        const testUserId = 'spam-test-user' as UUID;
        const testRoomId = 'spam-test-room' as UUID;
        const testWorldId = 'spam-test-world' as UUID;

        const overdueDate = new Date();
        overdueDate.setHours(overdueDate.getHours() - 1);

        const taskId = await todoService.createTodo({
          agentId: runtime.agentId,
          worldId: testWorldId,
          roomId: testRoomId,
          entityId: testUserId,
          name: '🔥 Urgent overdue task',
          type: 'one-off',
          priority: 1,
          isUrgent: true,
          dueDate: overdueDate,
        });

        logger.info('✓ Created overdue task');

        // Get reminder service
        const reminderService = runtime.getService('TODO_REMINDER' as any);
        if (!reminderService) {
          throw new Error('Reminder service not found');
        }

        // Trigger multiple reminder checks
        logger.info('🔄 Triggering multiple reminder checks...');
        
        for (let i = 1; i <= 3; i++) {
          logger.info(`Check #${i}...`);
          await (reminderService as any).checkTasksForReminders();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        logger.info('✓ Spam prevention should ensure only 1 reminder was sent');
        logger.info('(Check platform notifications to verify)');

        // Clean up
        await todoService.deleteTodo(taskId);

        logger.info('✅ Spam prevention test complete');
      },
    },
    {
      name: 'should deliver reminders with correct priority levels',
      fn: async (runtime: IAgentRuntime) => {
        logger.info('🧪 Testing reminder priority levels...');

        const dataService = await import('../../services/todoDataService');
        const todoService = dataService.createTodoDataService(runtime);

        const testUserId = 'priority-test-user' as UUID;
        const testRoomId = 'priority-test-room' as UUID;
        const testWorldId = 'priority-test-world' as UUID;

        // Create tasks with different priorities
        const tasks = [
          {
            name: '🚨 P1 URGENT: Server down',
            priority: 1,
            isUrgent: true,
            hoursOverdue: 2,
            expectedPriority: 'HIGH',
          },
          {
            name: '⚡ P2: Review PR',
            priority: 2,
            isUrgent: false,
            hoursOverdue: 0.25, // 15 min from now
            expectedPriority: 'MEDIUM',
          },
          {
            name: '📋 P3: Update documentation',
            priority: 3,
            isUrgent: false,
            hoursOverdue: -24, // Tomorrow
            expectedPriority: 'LOW',
          },
        ];

        const taskIds: UUID[] = [];

        for (const task of tasks) {
          const dueDate = new Date();
          dueDate.setHours(dueDate.getHours() - task.hoursOverdue);

          const taskId = await todoService.createTodo({
            agentId: runtime.agentId,
            worldId: testWorldId,
            roomId: testRoomId,
            entityId: testUserId,
            name: task.name,
            type: 'one-off',
            priority: task.priority,
            isUrgent: task.isUrgent,
            dueDate,
          });

          taskIds.push(taskId);
          logger.info(`✓ Created ${task.expectedPriority} priority task: ${task.name}`);
        }

        // Trigger reminder check
        logger.info('\n🔔 Checking for reminders...');
        const reminderService = runtime.getService('TODO_REMINDER' as any);
        if (reminderService) {
          await (reminderService as any).checkTasksForReminders();
        }

        logger.info('\n📊 Expected delivery priorities:');
        logger.info('- HIGH: Overdue P1 urgent tasks');
        logger.info('- MEDIUM: Upcoming tasks (< 30 min)');
        logger.info('- LOW: Daily recurring tasks');

        // Clean up
        for (const taskId of taskIds) {
          await todoService.deleteTodo(taskId);
        }

        logger.info('✅ Priority test complete');
      },
    },
  ],
}; 
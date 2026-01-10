import type { IAgentRuntime, UUID } from '@elizaos/core';
import { createTodoDataService } from '../services/todoDataService';
import { TodoReminderService } from '../services/reminderService';
import { v4 as uuidv4 } from 'uuid';

/**
 * Demo script to test reminder delivery through rolodex
 * This creates various todo scenarios to test the reminder system
 */
export async function setupReminderDemo(runtime: IAgentRuntime) {
  console.log('🚀 Setting up reminder demo scenarios...\n');

  const dataService = createTodoDataService(runtime);
  
  // Test user details
  const testUserId = 'test-user-123' as UUID;
  const testRoomId = 'test-room-456' as UUID;
  const testWorldId = 'test-world-789' as UUID;

  // Scenario 1: Overdue task (should trigger immediately)
  console.log('📌 Scenario 1: Creating an overdue task...');
  const overdueDate = new Date();
  overdueDate.setHours(overdueDate.getHours() - 2); // 2 hours overdue
  
  const overdueTaskId = await dataService.createTodo({
    agentId: runtime.agentId,
    worldId: testWorldId,
    roomId: testRoomId,
    entityId: testUserId,
    name: '🚨 Submit expense report',
    description: 'Q4 expense report submission - URGENT',
    type: 'one-off',
    priority: 1,
    isUrgent: true,
    dueDate: overdueDate,
    tags: ['urgent', 'finance', 'overdue'],
  });
  console.log(`✅ Created overdue task: ${overdueTaskId}`);

  // Scenario 2: Task due in 15 minutes (should trigger upcoming reminder)
  console.log('\n📌 Scenario 2: Creating a task due in 15 minutes...');
  const upcomingDate = new Date();
  upcomingDate.setMinutes(upcomingDate.getMinutes() + 15);
  
  const upcomingTaskId = await dataService.createTodo({
    agentId: runtime.agentId,
    worldId: testWorldId,
    roomId: testRoomId,
    entityId: testUserId,
    name: '📞 Team standup call',
    description: 'Daily team sync on Discord',
    type: 'one-off',
    priority: 2,
    isUrgent: false,
    dueDate: upcomingDate,
    tags: ['meeting', 'team'],
  });
  console.log(`✅ Created upcoming task: ${upcomingTaskId}`);

  // Scenario 3: Daily recurring task (will remind at 9 AM and 6 PM)
  console.log('\n📌 Scenario 3: Creating daily recurring tasks...');
  
  const dailyTasks = [
    {
      name: '💊 Take morning vitamins',
      description: 'Vitamin D, B12, and Omega-3',
      tags: ['health', 'daily', 'morning'],
    },
    {
      name: '🏃 30-minute exercise',
      description: 'Cardio or strength training',
      tags: ['health', 'daily', 'fitness'],
    },
    {
      name: '📚 Read for 20 minutes',
      description: 'Continue reading current book',
      tags: ['personal', 'daily', 'learning'],
    },
  ];

  for (const task of dailyTasks) {
    const taskId = await dataService.createTodo({
      agentId: runtime.agentId,
      worldId: testWorldId,
      roomId: testRoomId,
      entityId: testUserId,
      name: task.name,
      description: task.description,
      type: 'daily',
      priority: 3,
      isUrgent: false,
      tags: task.tags,
    });
    console.log(`✅ Created daily task: ${task.name} (${taskId})`);
  }

  // Scenario 4: Future tasks with various deadlines
  console.log('\n📌 Scenario 4: Creating future tasks with deadlines...');
  
  const futureTasks = [
    {
      name: '📝 Finish project proposal',
      hoursFromNow: 4,
      priority: 2,
      isUrgent: false,
    },
    {
      name: '🎂 Buy birthday gift for Sarah',
      hoursFromNow: 24,
      priority: 3,
      isUrgent: false,
    },
    {
      name: '✈️ Check in for flight',
      hoursFromNow: 48,
      priority: 1,
      isUrgent: true,
    },
  ];

  for (const task of futureTasks) {
    const dueDate = new Date();
    dueDate.setHours(dueDate.getHours() + task.hoursFromNow);
    
    const taskId = await dataService.createTodo({
      agentId: runtime.agentId,
      worldId: testWorldId,
      roomId: testRoomId,
      entityId: testUserId,
      name: task.name,
      type: 'one-off',
      priority: task.priority,
      isUrgent: task.isUrgent,
      dueDate,
      tags: ['future'],
    });
    console.log(`✅ Created future task: ${task.name} (due in ${task.hoursFromNow}h)`);
  }

  // Scenario 5: Aspirational tasks (no due date)
  console.log('\n📌 Scenario 5: Creating aspirational tasks...');
  
  const aspirationalTasks = [
    '🎸 Learn to play guitar',
    '🗣️ Become fluent in Spanish',
    '🏔️ Climb Mount Kilimanjaro',
  ];

  for (const taskName of aspirationalTasks) {
    const taskId = await dataService.createTodo({
      agentId: runtime.agentId,
      worldId: testWorldId,
      roomId: testRoomId,
      entityId: testUserId,
      name: taskName,
      type: 'aspirational',
      priority: 4,
      isUrgent: false,
      tags: ['goals', 'long-term'],
    });
    console.log(`✅ Created aspirational task: ${taskName}`);
  }

  console.log('\n📊 Demo Summary:');
  console.log('- 1 overdue task (immediate high-priority reminder)');
  console.log('- 1 task due in 15 minutes (upcoming reminder)');
  console.log('- 3 daily recurring tasks (9 AM & 6 PM reminders)');
  console.log('- 3 future tasks with various deadlines');
  console.log('- 3 aspirational tasks (no reminders)');

  // Force an immediate reminder check
  console.log('\n🔔 Triggering immediate reminder check...');
  const reminderService = runtime.getService('TODO_REMINDER' as any) as TodoReminderService;
  if (reminderService) {
    await reminderService.checkTasksForReminders();
    console.log('✅ Reminder check complete!');
  } else {
    console.log('⚠️ Reminder service not found - make sure it\'s initialized');
  }

  console.log('\n📱 Expected behavior:');
  console.log('1. Overdue task should trigger immediately with HIGH priority');
  console.log('2. 15-minute task should trigger with MEDIUM priority');
  console.log('3. Daily tasks will remind at 9 AM and 6 PM with LOW priority');
  console.log('4. Future tasks will remind 30 minutes before due time');
  console.log('5. Check your connected platforms (Discord/Slack/etc) for notifications!');

  return {
    testUserId,
    testRoomId,
    testWorldId,
    overdueTaskId,
    upcomingTaskId,
  };
}

/**
 * Monitor reminder delivery for testing
 */
export async function monitorReminders(runtime: IAgentRuntime, duration: number = 60000) {
  console.log(`\n👀 Monitoring reminders for ${duration / 1000} seconds...`);
  
  const startTime = Date.now();
  const checkInterval = 5000; // Check every 5 seconds
  
  const monitor = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const remaining = duration - elapsed;
    
    if (remaining <= 0) {
      clearInterval(monitor);
      console.log('\n✅ Monitoring complete!');
      return;
    }
    
    console.log(`⏱️  ${Math.floor(remaining / 1000)}s remaining...`);
  }, checkInterval);
  
  // Wait for monitoring to complete
  await new Promise(resolve => setTimeout(resolve, duration));
}

/**
 * Clean up demo tasks
 */
export async function cleanupDemo(runtime: IAgentRuntime, testUserId: UUID) {
  console.log('\n🧹 Cleaning up demo tasks...');
  
  const dataService = createTodoDataService(runtime);
  const todos = await dataService.getTodos({ entityId: testUserId });
  
  for (const todo of todos) {
    await dataService.deleteTodo(todo.id);
  }
  
  console.log(`✅ Deleted ${todos.length} demo tasks`);
}

// Export for use in tests or direct execution
export default {
  setupReminderDemo,
  monitorReminders,
  cleanupDemo,
}; 
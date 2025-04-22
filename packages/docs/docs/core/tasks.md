---
sidebar_position: 9
title: Tasks System
description: Understanding ElizaOS tasks - managing deferred, scheduled, and interactive operations
keywords: [tasks, scheduling, automation, workers, recurring tasks, task management]
image: /img/tasks.jpg
---

# Tasks

Tasks in ElizaOS provide a powerful way to manage deferred, scheduled, and interactive operations. The Task system allows agents to queue work for later execution, repeat actions at defined intervals, await user input, and implement complex workflows across multiple interactions.

## Task Structure

A task in ElizaOS has the following properties:

```typescript
interface Task {
  id?: UUID; // Unique identifier (auto-generated if not provided)
  name: string; // Name of the task (must match a registered task worker)
  updatedAt?: number; // Timestamp when the task was last updated
  metadata?: {
    // Optional additional configuration
    updateInterval?: number; // For repeating tasks: milliseconds between executions
    options?: {
      // For choice tasks: options for user selection
      name: string;
      description: string;
    }[];
    [key: string]: unknown; // Additional custom metadata
  };
  description: string; // Human-readable description of the task
  roomId?: UUID; // Optional room association (for room-specific tasks)
  worldId?: UUID; // Optional world association (for world-specific tasks)
  tags: string[]; // Tags for categorizing and filtering tasks
}
```

## Task Workers

Task workers define the actual logic that executes when a task runs. Each task worker is registered with the runtime and is identified by name.

```typescript
interface TaskWorker {
  name: string; // Matches the name in the Task
  execute: (
    runtime: IAgentRuntime,
    options: { [key: string]: unknown }, // Options passed during execution
    task: Task // The task being executed
  ) => Promise<void>;
  validate?: (
    // Optional validation before execution
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ) => Promise<boolean>;
}
```

## Creating and Managing Tasks

### Registering a Task Worker

Before creating tasks, you must register a worker to handle the execution:

```typescript
runtime.registerTaskWorker({
  name: 'SEND_REMINDER',
  validate: async (runtime, message, state) => {
    // Optional validation logic
    return true;
  },
  execute: async (runtime, options, task) => {
    // Task execution logic
    const { roomId } = task;
    const { reminder, userId } = options;

    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId,
        content: {
          text: `Reminder for <@${userId}>: ${reminder}`,
        },
      },
      'messages'
    );

    // Delete the task after it's completed
    await runtime.deleteTask(task.id);
  },
});
```

### Creating a One-time Task

Create a task that will execute once:

```typescript
await runtime.createTask({
  name: 'SEND_REMINDER',
  description: 'Send a reminder message to the user',
  roomId: currentRoomId,
  tags: ['reminder', 'one-time'],
  metadata: {
    userId: message.entityId,
    reminder: 'Submit your weekly report',
    scheduledFor: Date.now() + 86400000, // 24 hours from now
  },
});
```

### Creating a Recurring Task

Create a task that repeats at regular intervals:

```typescript
await runtime.createTask({
  name: 'DAILY_REPORT',
  description: 'Generate and post the daily report',
  roomId: announcementChannelId,
  worldId: serverWorldId,
  tags: ['report', 'repeat', 'daily'],
  metadata: {
    updateInterval: 86400000, // 24 hours in milliseconds
    updatedAt: Date.now(), // When the task was last updated/executed
  },
});
```

### Creating a Task Awaiting User Choice

Create a task that presents options and waits for user input:

```typescript
await runtime.createTask({
  name: 'CONFIRM_ACTION',
  description: 'Confirm the requested action',
  roomId: message.roomId,
  tags: ['confirmation', 'AWAITING_CHOICE'],
  metadata: {
    options: [
      { name: 'confirm', description: 'Proceed with the action' },
      { name: 'cancel', description: 'Cancel the action' },
    ],
    action: 'DELETE_FILES',
    files: ['document1.txt', 'document2.txt'],
  },
});
```

### Managing Tasks

Retrieve, update, and delete tasks as needed:

```typescript
// Get tasks by specific criteria
const reminderTasks = await runtime.getTasks({
  roomId: currentRoomId,
  tags: ['reminder'],
});

// Get tasks by name
const reportTasks = await runtime.getTasksByName('DAILY_REPORT');

// Get a specific task
const task = await runtime.getTask(taskId);

// Update a task
await runtime.updateTask(taskId, {
  description: 'Updated description',
  metadata: {
    ...task.metadata,
    priority: 'high',
  },
});

// Delete a task
await runtime.deleteTask(taskId);
```

## Task Processing

Tasks are processed based on their configuration:

### One-time Tasks

Tasks without an `updateInterval` are executed once when triggered by your code. You are responsible for scheduling their execution by checking for pending tasks in appropriate contexts.

### Recurring Tasks

Tasks with an `updateInterval` are automatically considered for re-execution when:

1. The current time exceeds `updatedAt + updateInterval`
2. Your code explicitly checks for pending recurring tasks

To process recurring tasks, implement logic like this:

```typescript
// In an initialization function or periodic check
async function processRecurringTasks() {
  const now = Date.now();
  const recurringTasks = await runtime.getTasks({
    tags: ['repeat'],
  });

  for (const task of recurringTasks) {
    if (!task.metadata?.updateInterval) continue;

    const lastUpdate = task.metadata.updatedAt || 0;
    const interval = task.metadata.updateInterval;

    if (now >= lastUpdate + interval) {
      const worker = runtime.getTaskWorker(task.name);
      if (worker) {
        try {
          await worker.execute(runtime, {}, task);

          // Update the task's last update time
          await runtime.updateTask(task.id, {
            metadata: {
              ...task.metadata,
              updatedAt: now,
            },
          });
        } catch (error) {
          logger.error(`Error executing task ${task.name}: ${error}`);
        }
      }
    }
  }
}
```

### Tasks Awaiting User Input

Tasks tagged with `AWAITING_CHOICE` are presented to users and wait for their input. These tasks use:

1. The `choice` provider to display available options to users
2. The `CHOOSE_OPTION` action to process user selections

## Common Task Patterns

### Deferred Follow-ups

Create a task to follow up with a user later:

```typescript
runtime.registerTaskWorker({
  name: 'FOLLOW_UP',
  execute: async (runtime, options, task) => {
    const { roomId } = task;
    const { userId, topic } = task.metadata;

    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId,
        content: {
          text: `Hi <@${userId}>, I'm following up about ${topic}. Do you have any updates?`,
        },
      },
      'messages'
    );

    await runtime.deleteTask(task.id);
  },
});

// Create a follow-up task for 2 days later
await runtime.createTask({
  name: 'FOLLOW_UP',
  description: 'Follow up with user about project status',
  roomId: message.roomId,
  tags: ['follow-up', 'one-time'],
  metadata: {
    userId: message.entityId,
    topic: 'the project timeline',
    scheduledFor: Date.now() + 2 * 86400000, // 2 days
  },
});
```

### Multi-step Workflows

Implement complex workflows that span multiple interactions:

```typescript
// First step: Gather requirements
runtime.registerTaskWorker({
  name: 'GATHER_REQUIREMENTS',
  execute: async (runtime, options, task) => {
    // Ask user for requirements and create a new task for the next step
    await runtime.createTask({
      name: 'CONFIRM_REQUIREMENTS',
      description: 'Confirm gathered requirements',
      roomId: task.roomId,
      tags: ['workflow', 'AWAITING_CHOICE'],
      metadata: {
        previousStep: 'GATHER_REQUIREMENTS',
        requirements: options.requirements,
        options: [
          { name: 'confirm', description: 'Confirm requirements are correct' },
          { name: 'revise', description: 'Need to revise requirements' },
        ],
      },
    });

    await runtime.deleteTask(task.id);
  },
});

// Second step: Confirm requirements
runtime.registerTaskWorker({
  name: 'CONFIRM_REQUIREMENTS',
  execute: async (runtime, options, task) => {
    if (options.option === 'confirm') {
      // Move to the next step
      await runtime.createTask({
        name: 'GENERATE_SOLUTION',
        description: 'Generate solution based on requirements',
        roomId: task.roomId,
        tags: ['workflow'],
        metadata: {
          previousStep: 'CONFIRM_REQUIREMENTS',
          requirements: task.metadata.requirements,
        },
      });
    } else {
      // Go back to requirements gathering
      await runtime.createTask({
        name: 'GATHER_REQUIREMENTS',
        description: 'Revise requirements',
        roomId: task.roomId,
        tags: ['workflow'],
        metadata: {
          previousStep: 'CONFIRM_REQUIREMENTS',
          previousRequirements: task.metadata.requirements,
        },
      });
    }

    await runtime.deleteTask(task.id);
  },
});
```

### Scheduled Reports

Create tasks that generate and post reports on a schedule:

```typescript
runtime.registerTaskWorker({
  name: 'GENERATE_WEEKLY_REPORT',
  execute: async (runtime, options, task) => {
    const { roomId } = task;

    // Generate report content
    const reportData = await generateWeeklyReport(runtime);

    // Post the report
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId,
        content: {
          text: `# Weekly Report\n\n${reportData}`,
        },
      },
      'messages'
    );

    // The task stays active for next week (updateInterval handles timing)
  },
});

// Create a weekly report task
await runtime.createTask({
  name: 'GENERATE_WEEKLY_REPORT',
  description: 'Generate and post weekly activity report',
  roomId: reportChannelId,
  worldId: serverWorldId,
  tags: ['report', 'repeat', 'weekly'],
  metadata: {
    updateInterval: 7 * 86400000, // 7 days
    updatedAt: Date.now(),
    format: 'markdown',
  },
});
```

## Task Events and Monitoring

ElizaOS doesn't currently provide built-in events for task lifecycle, so implement your own monitoring if needed:

```typescript
// Custom monitoring for task execution
async function executeTaskWithMonitoring(runtime, taskWorker, task) {
  try {
    // Create a start log
    await runtime.log({
      body: { taskId: task.id, action: 'start' },
      entityId: runtime.agentId,
      roomId: task.roomId,
      type: 'TASK_EXECUTION',
    });

    // Execute the task
    await taskWorker.execute(runtime, {}, task);

    // Create a completion log
    await runtime.log({
      body: { taskId: task.id, action: 'complete', success: true },
      entityId: runtime.agentId,
      roomId: task.roomId,
      type: 'TASK_EXECUTION',
    });
  } catch (error) {
    // Create an error log
    await runtime.log({
      body: { taskId: task.id, action: 'error', error: error.message },
      entityId: runtime.agentId,
      roomId: task.roomId,
      type: 'TASK_EXECUTION',
    });
  }
}
```

## Best Practices

1. **Use descriptive names and descriptions**: Make tasks easily identifiable with clear names and descriptions

2. **Clean up completed tasks**: Delete one-time tasks after execution to prevent database bloat

3. **Add error handling**: Implement robust error handling in task workers to prevent failures from breaking workflows

4. **Use appropriate tags**: Tag tasks effectively for easy retrieval and categorization

5. **Validate carefully**: Use the `validate` function to ensure tasks only execute in appropriate contexts

6. **Keep tasks atomic**: Design tasks to perform specific, well-defined operations rather than complex actions

7. **Provide clear choices**: When creating choice tasks, make option names and descriptions clear and unambiguous

8. **Manage task lifecycles**: Have a clear strategy for when tasks are created, updated, and deleted

9. **Set reasonable intervals**: For recurring tasks, choose appropriate update intervals that balance timeliness and resource usage

10. **Handle concurrent execution**: Ensure task execution is idempotent to handle potential concurrent executions

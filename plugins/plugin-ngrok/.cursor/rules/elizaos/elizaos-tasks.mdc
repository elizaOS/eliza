---
description: Task system, choices, deferred tasks, ongoing tasks, queue system, tasks can be continuous and repeated or one time
globs:
alwaysApply: false
---

# ElizaOS Tasks System

Tasks provide a powerful way to manage deferred, scheduled, and interactive operations. They enable agents to queue work for later execution, repeat actions at intervals, await user input, and implement complex workflows.

## Core Concepts

### Task Structure

```typescript
interface Task {
  id?: UUID; // Unique identifier (auto-generated)
  name: string; // Task worker name (must match registered worker)
  updatedAt?: number; // Last update timestamp
  metadata?: {
    updateInterval?: number; // Milliseconds between executions (recurring)
    options?: {
      // Choice task options
      name: string;
      description: string;
    }[];
    [key: string]: unknown; // Additional custom metadata
  };
  description: string; // Human-readable description
  roomId?: UUID; // Optional room association
  worldId?: UUID; // Optional world association
  tags: string[]; // Categorization tags
}
```

### Task Worker

```typescript
interface TaskWorker {
  name: string; // Matches task.name
  execute: (
    runtime: IAgentRuntime,
    options: { [key: string]: unknown },
    task: Task
  ) => Promise<void>;
  validate?: (
    // Optional pre-execution validation
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ) => Promise<boolean>;
}
```

## Task Worker Registration

Workers must be registered before creating tasks:

```typescript
runtime.registerTaskWorker({
  name: 'SEND_REMINDER',

  validate: async (runtime, message, state) => {
    // Optional validation logic
    return true;
  },

  execute: async (runtime, options, task) => {
    const { roomId } = task;
    const { reminder, userId } = options;

    // Create reminder message
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

    // Delete one-time task
    await runtime.deleteTask(task.id);
  },
});
```

## Task Types

### One-time Tasks

Execute once when triggered:

```typescript
await runtime.createTask({
  name: 'SEND_REMINDER',
  description: 'Send reminder message',
  roomId: currentRoomId,
  tags: ['reminder', 'one-time'],
  metadata: {
    userId: message.entityId,
    reminder: 'Submit weekly report',
    scheduledFor: Date.now() + 86400000, // 24 hours
  },
});
```

### Recurring Tasks

Repeat at regular intervals:

```typescript
await runtime.createTask({
  name: 'DAILY_REPORT',
  description: 'Generate daily report',
  roomId: announcementChannelId,
  worldId: serverWorldId,
  tags: ['report', 'repeat', 'daily'],
  metadata: {
    updateInterval: 86400000, // 24 hours
    updatedAt: Date.now(),
  },
});
```

### Choice Tasks

Await user input with options:

```typescript
await runtime.createTask({
  name: 'CONFIRM_ACTION',
  description: 'Confirm requested action',
  roomId: message.roomId,
  tags: ['confirmation', 'AWAITING_CHOICE'],
  metadata: {
    options: [
      { name: 'confirm', description: 'Proceed with action' },
      { name: 'cancel', description: 'Cancel action' },
    ],
    action: 'DELETE_FILES',
    files: ['document1.txt', 'document2.txt'],
  },
});
```

## Task Management

```typescript
// Get tasks by criteria
const reminderTasks = await runtime.getTasks({
  roomId: currentRoomId,
  tags: ['reminder'],
});

// Get tasks by name
const reportTasks = await runtime.getTasksByName('DAILY_REPORT');

// Get specific task
const task = await runtime.getTask(taskId);

// Update task
await runtime.updateTask(taskId, {
  description: 'Updated description',
  metadata: {
    ...task.metadata,
    priority: 'high',
  },
});

// Delete task
await runtime.deleteTask(taskId);
```

## Task Processing

### Recurring Task Processing

Implement logic to check and execute recurring tasks:

```typescript
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

          // Update last execution time
          await runtime.updateTask(task.id, {
            metadata: {
              ...task.metadata,
              updatedAt: now,
            },
          });
        } catch (error) {
          logger.error(`Error executing task ${task.name}:`, error);
        }
      }
    }
  }
}
```

## Common Task Patterns

### Deferred Follow-up

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
          text: `Hi <@${userId}>, following up about ${topic}. Any updates?`,
        },
      },
      'messages'
    );

    await runtime.deleteTask(task.id);
  },
});

// Create follow-up for 2 days later
await runtime.createTask({
  name: 'FOLLOW_UP',
  description: 'Follow up on project status',
  roomId: message.roomId,
  tags: ['follow-up', 'one-time'],
  metadata: {
    userId: message.entityId,
    topic: 'the project timeline',
    scheduledFor: Date.now() + 2 * 86400000,
  },
});
```

### Multi-step Workflow

```typescript
// Step 1: Gather requirements
runtime.registerTaskWorker({
  name: 'GATHER_REQUIREMENTS',
  execute: async (runtime, options, task) => {
    // Create next step task
    await runtime.createTask({
      name: 'CONFIRM_REQUIREMENTS',
      description: 'Confirm requirements',
      roomId: task.roomId,
      tags: ['workflow', 'AWAITING_CHOICE'],
      metadata: {
        previousStep: 'GATHER_REQUIREMENTS',
        requirements: options.requirements,
        options: [
          { name: 'confirm', description: 'Requirements correct' },
          { name: 'revise', description: 'Need revision' },
        ],
      },
    });

    await runtime.deleteTask(task.id);
  },
});

// Step 2: Confirm requirements
runtime.registerTaskWorker({
  name: 'CONFIRM_REQUIREMENTS',
  execute: async (runtime, options, task) => {
    if (options.option === 'confirm') {
      // Next step
      await runtime.createTask({
        name: 'GENERATE_SOLUTION',
        description: 'Generate solution',
        roomId: task.roomId,
        tags: ['workflow'],
        metadata: {
          previousStep: 'CONFIRM_REQUIREMENTS',
          requirements: task.metadata.requirements,
        },
      });
    } else {
      // Go back
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

```typescript
runtime.registerTaskWorker({
  name: 'GENERATE_WEEKLY_REPORT',
  execute: async (runtime, options, task) => {
    const { roomId } = task;

    // Generate report
    const reportData = await generateWeeklyReport(runtime);

    // Post report
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

    // Task stays active for next week
  },
});

// Create weekly report task
await runtime.createTask({
  name: 'GENERATE_WEEKLY_REPORT',
  description: 'Weekly activity report',
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

## Best Practices

1. **Descriptive Names**: Use clear task and worker names
2. **Clean Up**: Delete one-time tasks after execution
3. **Error Handling**: Implement robust error handling
4. **Appropriate Tags**: Use tags for easy retrieval
5. **Validation**: Use validate function for context checks
6. **Atomic Tasks**: Keep tasks focused and simple
7. **Clear Choices**: Make options unambiguous
8. **Lifecycle Management**: Plan task creation/deletion
9. **Reasonable Intervals**: Balance timeliness and resources
10. **Idempotency**: Handle potential concurrent executions

## Integration with Services

Tasks often use services for execution:

```typescript
runtime.registerTaskWorker({
  name: 'CHECK_BLOCKCHAIN',
  execute: async (runtime, options, task) => {
    const solanaService = runtime.getService('solana');
    if (!solanaService) return;

    const balance = await solanaService.getBalance();

    if (balance < task.metadata.threshold) {
      await runtime.createMemory(
        {
          entityId: runtime.agentId,
          roomId: task.roomId,
          content: {
            text: `⚠️ Low balance alert: ${balance} SOL`,
          },
        },
        'messages'
      );
    }
  },
});
```

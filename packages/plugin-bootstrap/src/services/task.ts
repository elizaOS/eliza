// registered to runtime through plugin

import {
  logger,
  Service,
  ServiceType,
  type IAgentRuntime,
  type Memory,
  type State,
  type Task,
} from '@elizaos/core';

/**
 * TaskService class representing a service that schedules and executes tasks.
 * @extends Service
 * @property {NodeJS.Timeout|null} timer - Timer for executing tasks
 * @property {number} TICK_INTERVAL - Interval in milliseconds to check for tasks
 * @property {ServiceTypeName} serviceType - Service type of TASK
 * @property {string} capabilityDescription - Description of the service's capability
 * @static
 * @method start - Static method to start the TaskService
 * @method createTestTasks - Method to create test tasks
 * @method startTimer - Private method to start the timer for checking tasks
 * @method validateTasks - Private method to validate tasks
 * @method checkTasks - Private method to check tasks and execute them
 * @method executeTask - Private method to execute a task
 * @static
 * @method stop - Static method to stop the TaskService
 * @method stop - Method to stop the TaskService
 */
/**
 * Start the TaskService with the given runtime.
 * @param {IAgentRuntime} runtime - The runtime for the TaskService.
 */
export class TaskService extends Service {
  private timer: NodeJS.Timeout | null = null;
  private readonly TICK_INTERVAL = 1000; // Check every second
  static serviceType = ServiceType.TASK;
  capabilityDescription = 'The agent is able to schedule and execute tasks';

  /**
   * Start the TaskService with the given runtime.
   * @param {IAgentRuntime} runtime - The runtime for the TaskService.
   * @returns {Promise<Service>} A promise that resolves with the TaskService instance.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new TaskService(runtime);
    await service.startTimer();
    // await service.createTestTasks();
    return service;
  }

  /**
   * Asynchronously creates test tasks by registering task workers for repeating and one-time tasks,
   * validates the tasks, executes the tasks, and creates the tasks if they do not already exist.
   */
  async createTestTasks() {
    // Register task worker for repeating task
    this.runtime.registerTaskWorker({
      name: 'REPEATING_TEST_TASK',
      validate: async (_runtime, _message, _state) => {
        logger.debug('[Bootstrap] Validating repeating test task');
        return true;
      },
      execute: async (_runtime, _options) => {
        logger.debug('[Bootstrap] Executing repeating test task');
      },
    });

    // Register task worker for one-time task
    this.runtime.registerTaskWorker({
      name: 'ONETIME_TEST_TASK',
      validate: async (_runtime, _message, _state) => {
        logger.debug('[Bootstrap] Validating one-time test task');
        return true;
      },
      execute: async (_runtime, _options) => {
        logger.debug('[Bootstrap] Executing one-time test task');
      },
    });

    // check if the task exists
    const tasks = await this.runtime.getTasksByName('REPEATING_TEST_TASK');

    if (tasks.length === 0) {
      // Create repeating task
      await this.runtime.createTask({
        name: 'REPEATING_TEST_TASK',
        description: 'A test task that repeats every minute',
        metadata: {
          updatedAt: Date.now(), // Use timestamp instead of Date object
          updateInterval: 1000 * 60, // 1 minute
        },
        tags: ['queue', 'repeat', 'test'],
      });
    }

    // Create one-time task
    await this.runtime.createTask({
      name: 'ONETIME_TEST_TASK',
      description: 'A test task that runs once',
      metadata: {
        updatedAt: Date.now(),
      },
      tags: ['queue', 'test'],
    });
  }

  /**
   * Starts a timer that runs a function to check tasks at a specified interval.
   */
  private startTimer() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(async () => {
      try {
        await this.checkTasks();
      } catch (error) {
        logger.error('[Bootstrap] Error checking tasks:', error);
      }
    }, this.TICK_INTERVAL) as unknown as NodeJS.Timeout;
  }

  /**
   * Validates an array of Task objects.
   * Skips tasks without IDs or if no worker is found for the task.
   * If a worker has a `validate` function, it will run the validation using the `runtime`, `Memory`, and `State` parameters.
   * If the validation fails, the task will be skipped and the error will be logged.
   * @param {Task[]} tasks - An array of Task objects to validate.
   * @returns {Promise<Task[]>} - A Promise that resolves with an array of validated Task objects.
   */
  private async validateTasks(tasks: Task[]): Promise<Task[]> {
    const validatedTasks: Task[] = [];

    for (const task of tasks) {
      // Skip tasks without IDs
      if (!task.id) {
        continue;
      }

      const worker = this.runtime.getTaskWorker(task.name);

      // Skip if no worker found for task
      if (!worker) {
        continue;
      }

      // If worker has validate function, run validation
      if (worker.validate) {
        try {
          // Pass empty message and state since validation is time-based
          const isValid = await worker.validate(this.runtime, {} as Memory, {} as State);
          if (!isValid) {
            continue;
          }
        } catch (error) {
          logger.error(`[Bootstrap] Error validating task ${task.name}:`, error);
          continue;
        }
      }

      validatedTasks.push(task);
    }

    return validatedTasks;
  }

  /**
   * Checks if a scheduled task should run based on its schedule
   */
  private shouldRunScheduledTask(
    task: Task,
    currentDate: Date,
    scheduledTime: Date,
    lastRunTime: number,
    updateInterval: number
  ): boolean {
    const timeSinceLastRun = currentDate.getTime() - lastRunTime;

    if (lastRunTime === 0) {
      // First run - only run if we're within the scheduled time window
      const timeSinceScheduled = currentDate.getTime() - scheduledTime.getTime();

      // Check if we're within 60 seconds of the scheduled time
      const isWithinWindow = timeSinceScheduled >= 0 && timeSinceScheduled <= 60000;

      if (isWithinWindow) {
        logger.debug(
          `[Bootstrap] Scheduled task ${task.name} triggered at ${scheduledTime.getUTCHours()}:${scheduledTime.getUTCMinutes().toString().padStart(2, '0')} UTC`
        );
        return true;
      }

      // For first run, if we've already passed today's scheduled time, wait until tomorrow
      if (timeSinceScheduled > 60000) {
        logger.debug(
          `[Bootstrap] Scheduled task ${task.name} missed today's window (scheduled for ${scheduledTime.getUTCHours()}:${scheduledTime.getUTCMinutes().toString().padStart(2, '0')} UTC), will run tomorrow`
        );
      }

      return false;
    } else {
      // Subsequent runs - check if we've passed the scheduled time AND interval has passed
      const timeSinceScheduled = currentDate.getTime() - scheduledTime.getTime();
      const isScheduledTime = timeSinceScheduled >= 0 && timeSinceScheduled <= 60000;
      return isScheduledTime && timeSinceLastRun >= updateInterval;
    }
  }

  /**
   * Process a scheduled task (task with scheduledHour and scheduledMinute)
   */
  private async processScheduledTask(task: Task): Promise<void> {
    if (!task.metadata) return;

    const currentDate = new Date();
    const hour = typeof task.metadata.scheduledHour === 'number' ? task.metadata.scheduledHour : 0;
    const minute =
      typeof task.metadata.scheduledMinute === 'number' ? task.metadata.scheduledMinute : 0;

    // Create scheduled time in UTC for today
    const scheduledTime = new Date();
    scheduledTime.setUTCHours(hour, minute, 0, 0);

    // If we've already passed today's scheduled time and this is not within the execution window,
    // we should be checking against tomorrow's scheduled time
    const timeSinceScheduled = currentDate.getTime() - scheduledTime.getTime();
    if (timeSinceScheduled > 60000) {
      // More than 60 seconds past scheduled time
      // Move to tomorrow's scheduled time
      scheduledTime.setUTCDate(scheduledTime.getUTCDate() + 1);
    }

    const lastRunTime = typeof task.metadata.updatedAt === 'number' ? task.metadata.updatedAt : 0;
    const updateInterval =
      typeof task.metadata.updateInterval === 'number'
        ? task.metadata.updateInterval
        : 24 * 60 * 60 * 1000; // Default 24 hours

    const shouldRun = this.shouldRunScheduledTask(
      task,
      currentDate,
      scheduledTime,
      lastRunTime,
      updateInterval
    );

    if (shouldRun) {
      await this.executeTask(task);
    }
  }

  /**
   * Process an interval-based task
   */
  private async processIntervalTask(task: Task, now: number): Promise<void> {
    // Non-repeating tasks execute immediately
    if (!task.tags?.includes('repeat')) {
      await this.executeTask(task);
      return;
    }

    // Get task start time from various sources
    const taskStartTime = this.getTaskStartTime(task);
    const updateIntervalMs = task.metadata?.updateInterval ?? 0;

    // Check for immediate execution
    if (task.metadata?.updatedAt === task.metadata?.createdAt && task.tags?.includes('immediate')) {
      logger.debug(`[Bootstrap] Immediately running task ${task.name}`);
      await this.executeTask(task);
      return;
    }

    // Check if enough time has passed since last update
    if (now - taskStartTime >= updateIntervalMs) {
      logger.debug(
        `[Bootstrap] Executing task ${task.name} - interval of ${updateIntervalMs}ms has elapsed`
      );
      await this.executeTask(task);
    }
  }

  /**
   * Get the start time for a task, checking multiple sources
   */
  private getTaskStartTime(task: Task): number {
    if (typeof task.updatedAt === 'number') {
      return task.updatedAt;
    } else if (task.metadata?.updatedAt && typeof task.metadata.updatedAt === 'number') {
      return task.metadata.updatedAt;
    } else if (task.updatedAt) {
      return new Date(task.updatedAt).getTime();
    }
    return 0; // Default to immediate execution if no timestamp found
  }

  /**
   * Asynchronous method that checks tasks with "queue" tag, validates and sorts them, then executes them based on interval and tags.
   *
   * @returns {Promise<void>} Promise that resolves once all tasks are checked and executed
   */
  private async checkTasks() {
    try {
      // Get all tasks with "queue" tag
      const allTasks = await this.runtime.getTasks({
        tags: ['queue'],
      });

      // validate the tasks and sort them
      const tasks = await this.validateTasks(allTasks);

      if (tasks.length > 0) {
        logger.debug(`[Bootstrap] Checking ${tasks.length} queued tasks`);
      }

      const now = Date.now();

      for (const task of tasks) {
        // Check if this is a time-of-day scheduled task
        if (
          task.metadata?.scheduledHour !== undefined &&
          task.metadata?.scheduledMinute !== undefined
        ) {
          logger.debug(`[Bootstrap] Processing scheduled task ${task.name}`);
          await this.processScheduledTask(task);
          continue;
        }

        // Process interval-based tasks
        await this.processIntervalTask(task, now);
      }
    } catch (error) {
      logger.error('[Bootstrap] Error checking tasks:', error);
    }
  }

  /**
   * Executes a given task asynchronously.
   *
   * @param {Task} task - The task to be executed.
   */
  private async executeTask(task: Task) {
    try {
      if (!task || !task.id) {
        logger.debug(`[Bootstrap] Task not found`);
        return;
      }

      const worker = this.runtime.getTaskWorker(task.name);
      if (!worker) {
        logger.debug(`[Bootstrap] No worker found for task type: ${task.name}`);
        return;
      }

      // Handle repeating vs non-repeating tasks
      if (task.tags?.includes('repeat')) {
        // For repeating tasks, update the updatedAt timestamp
        await this.runtime.updateTask(task.id, {
          metadata: {
            ...task.metadata,
            updatedAt: Date.now(),
          },
        });
        logger.debug(
          `[Bootstrap] Updated repeating task ${task.name} (${task.id}) with new timestamp`
        );
      }

      logger.debug(`[Bootstrap] Executing task ${task.name} (${task.id})`);
      await worker.execute(this.runtime, task.metadata || {}, task);
      //logger.debug('task.tags are', task.tags);

      // Handle repeating vs non-repeating tasks
      if (!task.tags?.includes('repeat')) {
        // For non-repeating tasks, delete the task after execution
        await this.runtime.deleteTask(task.id);
        logger.debug(
          `[Bootstrap] Deleted non-repeating task ${task.name} (${task.id}) after execution`
        );
      }
    } catch (error) {
      logger.error(`[Bootstrap] Error executing task ${task.id}:`, error);
    }
  }

  /**
   * Stops the TASK service in the given agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime containing the service.
   * @returns {Promise<void>} - A promise that resolves once the service has been stopped.
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(ServiceType.TASK);
    if (service) {
      await service.stop();
    }
  }

  /**
   * Stops the timer if it is currently running.
   */

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

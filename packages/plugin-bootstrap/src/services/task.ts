// registered to runtime through plugin

import {
  logger,
  Service,
  ServiceType,
  type IAgentRuntime,
  type Memory,
  type ServiceTypeName,
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
  static serviceType: ServiceTypeName = ServiceType.TASK;
  capabilityDescription = 'The agent is able to schedule and execute tasks';

  /**
   * Start the TaskService with the given runtime.
   * @param {IAgentRuntime} runtime - The runtime for the TaskService.
   * @returns {Promise<TaskService>} A promise that resolves with the TaskService instance.
   */
  static async start(runtime: IAgentRuntime): Promise<TaskService> {
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
        logger.debug('Validating repeating test task');
        return true;
      },
      execute: async (_runtime, _options) => {
        logger.debug('Executing repeating test task');
      },
    });

    // Register task worker for one-time task
    this.runtime.registerTaskWorker({
      name: 'ONETIME_TEST_TASK',
      validate: async (_runtime, _message, _state) => {
        logger.debug('Validating one-time test task');
        return true;
      },
      execute: async (_runtime, _options) => {
        logger.debug('Executing one-time test task');
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
        logger.error('Error checking tasks:', error);
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
          logger.error(`Error validating task ${task.name}:`, error);
          continue;
        }
      }

      validatedTasks.push(task);
    }

    return validatedTasks;
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

      const now = Date.now();

      for (const task of tasks) {
        // First check task.updatedAt (for newer task format)
        // Then fall back to task.metadata.updatedAt (for older tasks)
        // Finally default to 0 if neither exists
        let taskStartTime: number;

        // if tags does not contain "repeat", execute immediately
        if (!task.tags?.includes('repeat')) {
          // does not contain repeat
          await this.executeTask(task);
          continue;
        }

        if (typeof task.updatedAt === 'number') {
          taskStartTime = task.updatedAt;
        } else if (task.metadata?.updatedAt && typeof task.metadata.updatedAt === 'number') {
          taskStartTime = task.metadata.updatedAt;
        } else if (task.updatedAt) {
          taskStartTime = new Date(task.updatedAt).getTime();
        } else {
          taskStartTime = 0; // Default to immediate execution if no timestamp found
        }

        // Get updateInterval from metadata
        const updateIntervalMs = task.metadata?.updateInterval ?? 0; // update immediately

        // if tags does not contain "repeat", execute immediately
        if (!task.tags?.includes('repeat')) {
          await this.executeTask(task);
          continue;
        }

        if (task.metadata.updatedAt === task.metadata.createdAt) {
          if (task.tags?.includes('immediate')) {
            logger.debug('immediately running task', task.name);
            await this.executeTask(task);
            continue;
          }
        }

        // Check if enough time has passed since last update
        if (now - taskStartTime >= updateIntervalMs) {
          logger.debug(
            `Executing task ${task.name} - interval of ${updateIntervalMs}ms has elapsed`
          );
          await this.executeTask(task);
        }
      }
    } catch (error) {
      logger.error('Error checking tasks:', error);
    }
  }

  /**
   * Executes a given task asynchronously.
   *
   * @param {Task} task - The task to be executed.
   */
  private async executeTask(task: Task) {
    try {
      if (!task) {
        logger.debug(`Task ${task.id} not found`);
        return;
      }

      const worker = this.runtime.getTaskWorker(task.name);
      if (!worker) {
        logger.debug(`No worker found for task type: ${task.name}`);
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
        logger.debug(`Updated repeating task ${task.name} (${task.id}) with new timestamp`);
      }

      logger.debug(`Executing task ${task.name} (${task.id})`);
      await worker.execute(this.runtime, task.metadata || {}, task);

      // Handle repeating vs non-repeating tasks
      if (!task.tags?.includes('repeat')) {
        // For non-repeating tasks, delete the task after execution
        await this.runtime.deleteTask(task.id);
        logger.debug(`Deleted non-repeating task ${task.name} (${task.id}) after execution`);
      }
    } catch (error) {
      logger.error(`Error executing task ${task.id}:`, error);
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

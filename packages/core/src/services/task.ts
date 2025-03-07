// registered to runtime through plugin

import logger from "../logger";
import {
  type IAgentRuntime,
  Service,
  ServiceTypes,
  type UUID,
  type ServiceType,
  type Memory,
  type State,
  type Task,
} from "../types";

export class TaskService extends Service {
  private timer: NodeJS.Timeout | null = null;
  private readonly TICK_INTERVAL = 1000; // Check every second
  static serviceType: ServiceType = ServiceTypes.TASK;
  capabilityDescription = "The agent is able to schedule and execute tasks";


  static async start(runtime: IAgentRuntime): Promise<TaskService> {
    const service = new TaskService(runtime);
    await service.startTimer();
    // await service.createTestTasks();
    return service;
  }

  async createTestTasks() {
    // Register task worker for repeating task
    this.runtime.registerTaskWorker({
      name: "REPEATING_TEST_TASK",
      validate: async (_runtime, _message, _state) => {
        logger.debug("Validating repeating test task");
        return true;
      },
      execute: async (_runtime, _options) => {
        logger.debug("Executing repeating test task");
      },
    });

    // Register task worker for one-time task
    this.runtime.registerTaskWorker({
      name: "ONETIME_TEST_TASK",
      validate: async (_runtime, _message, _state) => {
        logger.debug("Validating one-time test task");
        return true;
      },
      execute: async (_runtime, _options) => {
        logger.debug("Executing one-time test task");
      },
    });

    // check if the task exists
    const tasks = await this.runtime.getDatabaseAdapter().getTasksByName(
      "REPEATING_TEST_TASK"
    );

    if (tasks.length === 0) {
      // Create repeating task
      await this.runtime.getDatabaseAdapter().createTask({
        name: "REPEATING_TEST_TASK",
        description: "A test task that repeats every minute",
        metadata: {
          updatedAt: Date.now(), // Use timestamp instead of Date object
          updateInterval: 1000 * 60, // 1 minute
        },
        tags: ["queue", "repeat", "test"],
      });
    }

    // Create one-time task
    await this.runtime.getDatabaseAdapter().createTask({
      name: "ONETIME_TEST_TASK",
      description: "A test task that runs once",
      metadata: {
        updatedAt: Date.now(),
      },
      tags: ["queue", "test"],
    });
  }

  private startTimer() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(async () => {
      await this.checkTasks();
    }, this.TICK_INTERVAL);
  }

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
          const isValid = await worker.validate(
            this.runtime,
            {} as Memory,
            {} as State
          );
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

  private async checkTasks() {
    try {
      // Get all tasks with "queue" tag
      const allTasks = await this.runtime.getDatabaseAdapter().getTasks({
        tags: ["queue"],
      });

      // validate the tasks and sort them
      const tasks = await this.validateTasks(allTasks);

      if (tasks.length > 0) {
        logger.debug(`Found ${tasks.length} queued tasks`);
      }

      const now = Date.now();

      for (const task of tasks) {
        const taskStartTime = new Date(task.updatedAt || 0).getTime();

        // convert updatedAt which is an ISO string to a number
        const updateIntervalMs = task.metadata.updateInterval ?? 0; // update immediately

        // if tags does not contain "repeat", execute immediately
        if (!task.tags?.includes("repeat")) {
          await this.executeTask(task);
          continue;
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
      logger.error("Error checking tasks:", error);
    }
  }

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

      logger.debug(`Executing task ${task.name} (${task.id})`);
      await worker.execute(this.runtime, task.metadata || {});
      logger.debug("task.tags are", task.tags);
      // Handle repeating vs non-repeating tasks
      if (task.tags?.includes("repeat")) {
        // For repeating tasks, update the updatedAt timestamp
        await this.runtime.getDatabaseAdapter().updateTask(task.id, {
          metadata: {
            ...task.metadata,
            updatedAt: Date.now(),
          },
        });
        logger.debug(
          `Updated repeating task ${task.name} (${task.id}) with new timestamp`
        );
      } else {
        // For non-repeating tasks, delete the task after execution
        await this.runtime.getDatabaseAdapter().deleteTask(task.id);
        logger.debug(
          `Deleted non-repeating task ${task.name} (${task.id}) after execution`
        );
      }
    } catch (error) {
      logger.error(`Error executing task ${task.id}:`, error);
    }
  }

  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(ServiceTypes.TASK);
    if (service) {
      await service.stop();
    }
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

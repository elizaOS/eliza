import {
  type IAgentRuntime,
  logger,
  Service,
  type ServiceTypeName,
  type UUID,
} from "@elizaos/core";
import type { NotificationType } from "../types/index.js";
import { CacheManager } from "./cacheManager";
import { NotificationManager } from "./notificationManager";
import { createTodoDataService, type TodoData } from "./todoDataService";

type MessageDeliveryService = Service;
type EntityRelationshipService = Service;

interface ReminderMessage {
  entityId: UUID;
  message: string;
  priority: "low" | "medium" | "high";
  platforms?: string[];
  metadata?: {
    todoId: UUID;
    todoName: string;
    reminderType: string;
    dueDate?: Date;
  };
}

const TODO_CHECK_REMINDERS = "TODO_CHECK_REMINDERS";
const TODO_CACHE_CLEANUP = "TODO_CACHE_CLEANUP";
const TODO_PROCESS_NOTIFICATION_QUEUE = "TODO_PROCESS_NOTIFICATION_QUEUE";

export class TodoReminderService extends Service {
  static serviceType: ServiceTypeName = "TODO_REMINDER" as ServiceTypeName;
  serviceName = "TODO_REMINDER" as ServiceTypeName;
  capabilityDescription = "Manages todo reminders and notifications";

  private notificationManager!: NotificationManager;
  private cacheManager!: CacheManager;
  private reminderTaskId: UUID | null = null;
  private cacheCleanupTaskId: UUID | null = null;
  private notificationTaskId: UUID | null = null;
  private rolodexMessageService: MessageDeliveryService | null = null;
  private rolodexEntityService: EntityRelationshipService | null = null;
  private lastReminderCheck: Map<UUID, number> = new Map();

  static async start(runtime: IAgentRuntime): Promise<TodoReminderService> {
    logger.info("Starting TodoReminderService...");
    const service = new TodoReminderService();
    service.runtime = runtime;
    await service.initialize();
    logger.info("TodoReminderService started successfully");
    return service;
  }

  private async initialize(): Promise<void> {
    this.notificationManager = new NotificationManager(this.runtime, {
      useTaskScheduler: true,
    });
    this.cacheManager = new CacheManager();

    this.rolodexMessageService = this.runtime.getService("MESSAGE_DELIVERY" as ServiceTypeName);
    this.rolodexEntityService = this.runtime.getService("ENTITY_RELATIONSHIP" as ServiceTypeName);

    if (this.rolodexMessageService && this.rolodexEntityService) {
      logger.info("Rolodex services found - external message delivery enabled");
    } else {
      logger.warn("Rolodex services not found - only in-app notifications will be sent");
    }

    this.registerTaskWorkers();
    await this.ensureRecurringTasks();
    this.checkTasksForReminders().catch((error) => {
      logger.error(
        "Error in initial reminder check:",
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  private registerTaskWorkers(): void {
    const rt = this.runtime;
    rt.registerTaskWorker({
      name: TODO_CHECK_REMINDERS,
      execute: async () => {
        await this.checkTasksForReminders();
      },
    });
    rt.registerTaskWorker({
      name: TODO_CACHE_CLEANUP,
      execute: async () => {
        this.cacheManager.cleanup();
      },
    });
    rt.registerTaskWorker({
      name: TODO_PROCESS_NOTIFICATION_QUEUE,
      execute: async () => {
        await this.notificationManager.processQueue();
      },
    });
  }

  /** Idempotent: getTasksByName + filter by agentId; create recurring task only if none exists. */
  private async ensureRecurringTasks(): Promise<void> {
    const rt = this.runtime;
    const agentId = rt.agentId;
    if (
      typeof rt.getTasksByName !== "function" ||
      typeof rt.createTask !== "function"
    ) {
      return;
    }

    const existingReminders = await rt.getTasksByName(TODO_CHECK_REMINDERS);
    const myReminder = existingReminders.find(
      (t) => t.agentId != null && String(t.agentId) === String(agentId)
    );
    if (!myReminder?.id) {
      this.reminderTaskId = await rt.createTask({
        name: TODO_CHECK_REMINDERS,
        tags: ["queue", "repeat"],
        metadata: {
          updateInterval: 30_000,
          baseInterval: 30_000,
          updatedAt: Date.now(),
        },
      });
    } else {
      this.reminderTaskId = myReminder.id;
    }

    const existingCache = await rt.getTasksByName(TODO_CACHE_CLEANUP);
    const myCache = existingCache.find(
      (t) => t.agentId != null && String(t.agentId) === String(agentId)
    );
    if (!myCache?.id) {
      this.cacheCleanupTaskId = await rt.createTask({
        name: TODO_CACHE_CLEANUP,
        tags: ["queue", "repeat"],
        metadata: {
          updateInterval: 60_000,
          baseInterval: 60_000,
          updatedAt: Date.now(),
        },
      });
    } else {
      this.cacheCleanupTaskId = myCache.id;
    }

    const existingNotif = await rt.getTasksByName(TODO_PROCESS_NOTIFICATION_QUEUE);
    const myNotif = existingNotif.find(
      (t) => t.agentId != null && String(t.agentId) === String(agentId)
    );
    if (!myNotif?.id) {
      this.notificationTaskId = await rt.createTask({
        name: TODO_PROCESS_NOTIFICATION_QUEUE,
        tags: ["queue", "repeat"],
        metadata: {
          updateInterval: 1000,
          baseInterval: 1000,
          updatedAt: Date.now(),
        },
      });
    } else {
      this.notificationTaskId = myNotif.id;
    }

    logger.info(
      "Todo recurring tasks ensured (reminders 30s, cache cleanup 60s, notification queue 1s)"
    );
  }

  async checkTasksForReminders(): Promise<void> {
    const dataService = createTodoDataService(this.runtime);

    const todos = await dataService.getTodos({ isCompleted: false });

    for (const todo of todos) {
      await this.processTodoReminder(todo);
    }
  }

  private async processTodoReminder(todo: TodoData): Promise<void> {
    const now = new Date();
    let shouldRemind = false;
    let reminderType: "overdue" | "upcoming" | "daily" | "system" = "system";
    let priority: "low" | "medium" | "high" = "medium";

    const lastReminder = this.lastReminderCheck.get(todo.id) || 0;
    const timeSinceLastReminder = now.getTime() - lastReminder;
    const MIN_REMINDER_INTERVAL = 30 * 60 * 1000;

    if (timeSinceLastReminder < MIN_REMINDER_INTERVAL) {
      return;
    }

    if (todo.dueDate && todo.dueDate < now) {
      shouldRemind = true;
      reminderType = "overdue";
      priority = "high";
    } else if (todo.dueDate) {
      const timeUntilDue = todo.dueDate.getTime() - now.getTime();
      if (timeUntilDue < 30 * 60 * 1000 && timeUntilDue > 0) {
        shouldRemind = true;
        reminderType = "upcoming";
        priority = todo.isUrgent ? "high" : "medium";
      }
    } else if (todo.type === "daily") {
      const hour = now.getHours();
      if (hour === 9 || hour === 18) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (!todo.completedAt || todo.completedAt < today) {
          shouldRemind = true;
          reminderType = "daily";
          priority = "low";
        }
      }
    }

    if (shouldRemind) {
      await this.sendReminder(todo, reminderType, priority);
      this.lastReminderCheck.set(todo.id, now.getTime());
    }
  }

  private async sendReminder(
    todo: TodoData,
    reminderType: "overdue" | "upcoming" | "daily" | "system",
    priority: "low" | "medium" | "high"
  ): Promise<void> {
    const title = this.formatReminderTitle(todo, reminderType);
    const body = this.formatReminderBody(todo, reminderType);

    await this.notificationManager.queueNotification({
      title,
      body,
      type: reminderType as NotificationType,
      taskId: todo.id,
      roomId: todo.roomId,
      priority,
    });

    if (this.rolodexMessageService && this.rolodexEntityService) {
      const reminderMessage: ReminderMessage = {
        entityId: todo.entityId,
        message: `${title}\n\n${body}`,
        priority,
        metadata: {
          todoId: todo.id,
          todoName: todo.name,
          reminderType,
          dueDate: todo.dueDate || undefined,
        },
      };

      await this.sendRolodexReminder(reminderMessage);

      logger.info(`Sent ${reminderType} reminder via rolodex for todo: ${todo.name}`);
    }

    logger.info(`Sent ${reminderType} reminder for todo: ${todo.name}`);
  }

  private async sendRolodexReminder(reminder: ReminderMessage): Promise<void> {
    if (!this.rolodexMessageService) {
      logger.warn("Rolodex message service not available");
      return;
    }

    try {
      // Use the rolodex message delivery service to send to all available platforms
      // MessageDeliveryService is a temporary type placeholder until proper types are available
      const messageService = this.rolodexMessageService as Service & {
        sendMessage?: (params: {
          entityId: UUID;
          message: string;
          priority: string;
          metadata?: unknown;
        }) => Promise<{ success?: boolean; platforms?: string[]; error?: string } | undefined>;
      };
      const result = await messageService.sendMessage?.({
        entityId: reminder.entityId,
        message: reminder.message,
        priority: reminder.priority,
        metadata: reminder.metadata,
      });

      if (result?.success) {
        logger.info(
          `Reminder delivered via rolodex to platforms: ${result.platforms?.join(", ") || "unknown"}`
        );
      } else {
        logger.warn("Rolodex message delivery failed:", result?.error || "Unknown error");
      }
    } catch (error) {
      logger.error(
        "Error sending reminder through rolodex:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  private formatReminderTitle(todo: TodoData, reminderType: string): string {
    switch (reminderType) {
      case "overdue":
        return `?? OVERDUE: ${todo.name}`;
      case "upcoming":
        return `? REMINDER: ${todo.name}`;
      case "daily":
        return `?? Daily Reminder`;
      default:
        return `?? Reminder: ${todo.name}`;
    }
  }

  private formatReminderBody(todo: TodoData, reminderType: string): string {
    switch (reminderType) {
      case "overdue":
        return `Your task "${todo.name}" is overdue. Please complete it when possible.`;
      case "upcoming":
        return `Your task "${todo.name}" is due soon. Don't forget to complete it!`;
      case "daily":
        return `Don't forget to complete your daily tasks today!`;
      default:
        return `Reminder about your task: ${todo.name}`;
    }
  }

  async processBatchReminders(): Promise<void> {
    await this.checkTasksForReminders();
  }

  async stop(): Promise<void> {
    const rt = this.runtime;
    if (typeof rt.deleteTask === "function") {
      if (this.reminderTaskId) {
        await rt.deleteTask(this.reminderTaskId).catch(() => {});
        this.reminderTaskId = null;
      }
      if (this.cacheCleanupTaskId) {
        await rt.deleteTask(this.cacheCleanupTaskId).catch(() => {});
        this.cacheCleanupTaskId = null;
      }
      if (this.notificationTaskId) {
        await rt.deleteTask(this.notificationTaskId).catch(() => {});
        this.notificationTaskId = null;
      }
    }

    if (this.notificationManager) {
      await this.notificationManager.stop();
    }

    if (this.cacheManager) {
      await this.cacheManager.stop();
    }

    logger.info("TodoReminderService stopped");
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(TodoReminderService.serviceType);
    if (service) await service.stop();
  }
}

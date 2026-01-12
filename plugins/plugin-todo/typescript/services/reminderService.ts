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

export class TodoReminderService extends Service {
  static serviceType: ServiceTypeName = "TODO_REMINDER" as ServiceTypeName;
  serviceName = "TODO_REMINDER" as ServiceTypeName;
  capabilityDescription = "Manages todo reminders and notifications";

  private notificationManager!: NotificationManager;
  private cacheManager!: CacheManager;
  private reminderTimer: NodeJS.Timeout | null = null;
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
    this.notificationManager = new NotificationManager(this.runtime);
    this.cacheManager = new CacheManager();

    this.rolodexMessageService = this.runtime.getService("MESSAGE_DELIVERY" as ServiceTypeName);
    this.rolodexEntityService = this.runtime.getService("ENTITY_RELATIONSHIP" as ServiceTypeName);

    if (this.rolodexMessageService && this.rolodexEntityService) {
      logger.info("Rolodex services found - external message delivery enabled");
    } else {
      logger.warn("Rolodex services not found - only in-app notifications will be sent");
    }

    this.startReminderLoop();
  }

  private startReminderLoop(): void {
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
    }

    this.reminderTimer = setInterval(() => {
      this.checkTasksForReminders().catch((error) => {
        logger.error(
          "Error in reminder loop:",
          error instanceof Error ? error.message : String(error)
        );
      });
    }, 30 * 1000);

    this.checkTasksForReminders().catch((error) => {
      logger.error(
        "Error in initial reminder check:",
        error instanceof Error ? error.message : String(error)
      );
    });

    logger.info("Reminder loop started - checking every 30 seconds");
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
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
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

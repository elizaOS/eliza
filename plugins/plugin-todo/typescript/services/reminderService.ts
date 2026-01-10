import {
  Service,
  type IAgentRuntime,
  type ServiceTypeName,
  logger,
  type UUID,
  type Memory,
} from '@elizaos/core';
import { createTodoDataService, type TodoData } from './todoDataService';
import { NotificationManager } from './notificationManager';
import { CacheManager } from './cacheManager';

// Import rolodex services for actual message delivery
type MessageDeliveryService = any; // Temporary type until we can properly import
type EntityRelationshipService = any; // Temporary type until we can properly import

interface ReminderMessage {
  entityId: UUID;
  message: string;
  priority: 'low' | 'medium' | 'high';
  platforms?: string[];
  metadata?: {
    todoId: UUID;
    todoName: string;
    reminderType: string;
    dueDate?: Date;
  };
}

/**
 * Main todo reminder service that handles all reminder functionality
 */
export class TodoReminderService extends Service {
  static serviceType: ServiceTypeName = 'TODO_REMINDER' as ServiceTypeName;
  serviceName = 'TODO_REMINDER' as ServiceTypeName;
  capabilityDescription = 'Manages todo reminders and notifications';

  private notificationManager!: NotificationManager;
  private cacheManager!: CacheManager;
  private reminderTimer: NodeJS.Timeout | null = null;
  private rolodexMessageService: MessageDeliveryService | null = null;
  private rolodexEntityService: EntityRelationshipService | null = null;
  private lastReminderCheck: Map<UUID, number> = new Map(); // Track last reminder time per todo

  static async start(runtime: IAgentRuntime): Promise<TodoReminderService> {
    logger.info('Starting TodoReminderService...');
    const service = new TodoReminderService();
    service.runtime = runtime;
    await service.initialize();
    logger.info('TodoReminderService started successfully');
    return service;
  }

  private async initialize(): Promise<void> {
    // Initialize internal managers
    this.notificationManager = new NotificationManager(this.runtime);
    this.cacheManager = new CacheManager();

    // Try to get rolodex services for external message delivery
    try {
      this.rolodexMessageService = this.runtime.getService('MESSAGE_DELIVERY' as ServiceTypeName);
      this.rolodexEntityService = this.runtime.getService('ENTITY_RELATIONSHIP' as ServiceTypeName);
      
      if (this.rolodexMessageService && this.rolodexEntityService) {
        logger.info('Rolodex services found - external message delivery enabled');
      } else {
        logger.warn('Rolodex services not found - only in-app notifications will be sent');
      }
    } catch (error) {
      logger.warn('Could not initialize rolodex services:', error);
    }

    // Start reminder checking loop
    this.startReminderLoop();
  }

  private startReminderLoop(): void {
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
    }

    // Check for reminders every 30 seconds for better responsiveness
    this.reminderTimer = setInterval(
      () => {
        this.checkTasksForReminders().catch((error) => {
          logger.error('Error in reminder loop:', error);
        });
      },
      30 * 1000 // 30 seconds instead of 5 minutes
    );

    // Also run immediately on start
    this.checkTasksForReminders().catch((error) => {
      logger.error('Error in initial reminder check:', error);
    });

    logger.info('Reminder loop started - checking every 30 seconds');
  }

  async checkTasksForReminders(): Promise<void> {
    try {
      const dataService = createTodoDataService(this.runtime);

      // Get all incomplete todos
      const todos = await dataService.getTodos({ isCompleted: false });

      for (const todo of todos) {
        try {
          await this.processTodoReminder(todo);
        } catch (error) {
          logger.error(`Error processing reminder for todo ${todo.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error checking tasks for reminders:', error);
    }
  }

  private async processTodoReminder(todo: TodoData): Promise<void> {
    const now = new Date();
    let shouldRemind = false;
    let reminderType = 'general';
    let priority: 'low' | 'medium' | 'high' = 'medium';

    // Check last reminder time to avoid spam
    const lastReminder = this.lastReminderCheck.get(todo.id) || 0;
    const timeSinceLastReminder = now.getTime() - lastReminder;
    const MIN_REMINDER_INTERVAL = 30 * 60 * 1000; // 30 minutes

    if (timeSinceLastReminder < MIN_REMINDER_INTERVAL) {
      return; // Skip if we reminded recently
    }

    // Check if overdue
    if (todo.dueDate && todo.dueDate < now) {
      shouldRemind = true;
      reminderType = 'overdue';
      priority = 'high';
    }
    // Check if upcoming (within 30 minutes)
    else if (todo.dueDate) {
      const timeUntilDue = todo.dueDate.getTime() - now.getTime();
      if (timeUntilDue < 30 * 60 * 1000 && timeUntilDue > 0) {
        shouldRemind = true;
        reminderType = 'upcoming';
        priority = todo.isUrgent ? 'high' : 'medium';
      }
    }
    // Check daily tasks (remind in morning and evening)
    else if (todo.type === 'daily') {
      const hour = now.getHours();
      // Morning reminder at 9 AM
      if (hour === 9 || hour === 18) { // Evening reminder at 6 PM
        // Check if completed today
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (!todo.completedAt || todo.completedAt < today) {
          shouldRemind = true;
          reminderType = 'daily';
          priority = 'low';
        }
      }
    }

    if (shouldRemind) {
      await this.sendReminder(todo, reminderType, priority);
      this.lastReminderCheck.set(todo.id, now.getTime());
    }
  }

  private async sendReminder(todo: TodoData, reminderType: string, priority: 'low' | 'medium' | 'high'): Promise<void> {
    try {
      const title = this.formatReminderTitle(todo, reminderType);
      const body = this.formatReminderBody(todo, reminderType);

      // Always send in-app notification
      await this.notificationManager.queueNotification({
        title,
        body,
        type: reminderType as any,
        taskId: todo.id,
        roomId: todo.roomId,
        priority,
      });

      // If rolodex is available, send external notifications
      if (this.rolodexMessageService && this.rolodexEntityService) {
        try {
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

          // Send through rolodex message delivery service
          await this.sendRolodexReminder(reminderMessage);
          
          logger.info(`Sent ${reminderType} reminder via rolodex for todo: ${todo.name}`);
        } catch (error) {
          logger.error('Failed to send reminder via rolodex:', error);
        }
      }

      logger.info(`Sent ${reminderType} reminder for todo: ${todo.name}`);
    } catch (error) {
      logger.error(`Error sending reminder for todo ${todo.id}:`, error);
    }
  }

  private async sendRolodexReminder(reminder: ReminderMessage): Promise<void> {
    if (!this.rolodexMessageService) {
      logger.warn('Rolodex message service not available');
      return;
    }

    try {
      // Use the rolodex message delivery service to send to all available platforms
      const result = await this.rolodexMessageService.sendMessage({
        entityId: reminder.entityId,
        message: reminder.message,
        priority: reminder.priority,
        metadata: reminder.metadata,
        // Let rolodex determine the best platforms based on entity preferences
      });

      if (result && result.success) {
        logger.info(`Reminder delivered via rolodex to platforms: ${result.platforms?.join(', ') || 'unknown'}`);
      } else {
        logger.warn('Rolodex message delivery failed:', result?.error || 'Unknown error');
      }
    } catch (error) {
      logger.error('Error sending reminder through rolodex:', error);
      throw error;
    }
  }

  private formatReminderTitle(todo: TodoData, reminderType: string): string {
    switch (reminderType) {
      case 'overdue':
        return `⚠️ OVERDUE: ${todo.name}`;
      case 'upcoming':
        return `⏰ REMINDER: ${todo.name}`;
      case 'daily':
        return `📅 Daily Reminder`;
      default:
        return `📋 Reminder: ${todo.name}`;
    }
  }

  private formatReminderBody(todo: TodoData, reminderType: string): string {
    switch (reminderType) {
      case 'overdue':
        return `Your task "${todo.name}" is overdue. Please complete it when possible.`;
      case 'upcoming':
        return `Your task "${todo.name}" is due soon. Don't forget to complete it!`;
      case 'daily':
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

    logger.info('TodoReminderService stopped');
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(TodoReminderService.serviceType);
    if (service) await service.stop();
  }
}

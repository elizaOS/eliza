import {
  logger,
  type UUID,
  EventType,
  type MessagePayload,
  createMessageMemory,
  type IAgentRuntime,
} from '@elizaos/core';

export interface NotificationPreferences {
  enabled: boolean;
  sound: boolean;
  browserNotifications: boolean;
  reminderTypes: {
    overdue: boolean;
    upcoming: boolean;
    daily: boolean;
  };
  quietHours?: {
    start: number; // Hour in 24h format (0-23)
    end: number;
  };
}

export interface NotificationData {
  title: string;
  body: string;
  type: 'overdue' | 'upcoming' | 'daily' | 'system';
  priority?: 'low' | 'medium' | 'high';
  taskId?: UUID;
  roomId?: UUID;
  actions?: Array<{
    label: string;
    action: string;
  }>;
}

/**
 * Manager for handling notifications across different channels
 */
export class NotificationManager {
  private userPreferences: Map<UUID, NotificationPreferences> = new Map();
  private notificationQueue: NotificationData[] = [];
  private isProcessing = false;
  private queueTimer: NodeJS.Timeout | null = null;

  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.initialize();
  }

  private async initialize() {
    // Start processing queue
    this.startQueueProcessor();

    // Load user preferences from storage
    await this.loadUserPreferences();

    logger.info('NotificationManager initialized');
  }

  /**
   * Start the queue processor to handle notifications
   */
  private startQueueProcessor() {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
    }

    this.queueTimer = setInterval(() => this.processNotificationQueue(), 1000);
  }

  /**
   * Process queued notifications
   */
  private async processNotificationQueue() {
    if (this.isProcessing || this.notificationQueue.length === 0) return;

    this.isProcessing = true;
    try {
      while (this.notificationQueue.length > 0) {
        const notification = this.notificationQueue.shift();
        if (notification) {
          await this.sendNotification(notification);
        }
      }
    } catch (error) {
      logger.error('Error processing notification queue:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Queue a notification for delivery
   */
  public async queueNotification(notification: NotificationData) {
    // Check if we're in quiet hours
    if (this.isInQuietHours(notification.roomId)) {
      logger.debug('Notification queued for after quiet hours:', notification.title);
      return;
    }

    this.notificationQueue.push(notification);
  }

  /**
   * Send a notification through appropriate channels
   */
  private async sendNotification(notification: NotificationData) {
    try {
      // Send in-app notification
      await this.sendInAppNotification(notification);

      // Send browser notification if enabled
      if (this.shouldSendBrowserNotification(notification)) {
        await this.sendBrowserNotification(notification);
      }

      // Log notification for audit
      logger.info(`Notification sent: ${notification.title}`, {
        type: notification.type,
        priority: notification.priority,
      });
    } catch (error) {
      logger.error('Error sending notification:', error);
    }
  }

  /**
   * Send an in-app notification
   */
  private async sendInAppNotification(notification: NotificationData) {
    if (!notification.roomId) return;

    const message = createMessageMemory({
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: notification.roomId,
      content: {
        text: `🔔 ${notification.title}\n\n${notification.body}`,
        source: 'NOTIFICATION_MANAGER',
        metadata: {
          notificationType: notification.type,
          priority: notification.priority,
          taskId: notification.taskId,
          isNotification: true,
        },
      },
    });

    const payload: MessagePayload = {
      runtime: this.runtime,
      message,
      source: 'NOTIFICATION_MANAGER',
    };

    await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, payload);
  }

  /**
   * Send a browser notification (placeholder - would need browser context)
   */
  private async sendBrowserNotification(notification: NotificationData) {
    // In a real implementation, this would:
    // 1. Check for browser notification permission
    // 2. Create and show the notification
    // 3. Handle click events on the notification

    logger.debug('Browser notification would be sent:', {
      title: notification.title,
      body: notification.body,
      type: notification.type,
    });
  }

  /**
   * Check if browser notifications should be sent
   */
  private shouldSendBrowserNotification(notification: NotificationData): boolean {
    if (!notification.roomId) return false;

    const prefs = this.getUserPreferences(notification.roomId);
    if (!prefs.enabled || !prefs.browserNotifications) return false;

    // Check if this type of reminder is enabled
    switch (notification.type) {
      case 'overdue':
        return prefs.reminderTypes.overdue;
      case 'upcoming':
        return prefs.reminderTypes.upcoming;
      case 'daily':
        return prefs.reminderTypes.daily;
      case 'system':
        return true;
      default:
        return false;
    }
  }

  /**
   * Check if we're in quiet hours
   */
  private isInQuietHours(roomId?: UUID): boolean {
    if (!roomId) return false;

    const prefs = this.getUserPreferences(roomId);
    if (!prefs.quietHours) return false;

    const now = new Date();
    const currentHour = now.getHours();
    const { start, end } = prefs.quietHours;

    // Handle cases where quiet hours span midnight
    if (start <= end) {
      return currentHour >= start && currentHour < end;
    } else {
      return currentHour >= start || currentHour < end;
    }
  }

  /**
   * Get user preferences for notifications
   */
  public getUserPreferences(userOrRoomId: UUID): NotificationPreferences {
    const existing = this.userPreferences.get(userOrRoomId);
    if (existing) return existing;

    // Return default preferences
    const defaults: NotificationPreferences = {
      enabled: true,
      sound: true,
      browserNotifications: false,
      reminderTypes: {
        overdue: true,
        upcoming: true,
        daily: true,
      },
      quietHours: {
        start: 22, // 10 PM
        end: 8, // 8 AM
      },
    };

    this.userPreferences.set(userOrRoomId, defaults);
    return defaults;
  }

  /**
   * Update user preferences
   */
  public async updateUserPreferences(
    userOrRoomId: UUID,
    preferences: Partial<NotificationPreferences>
  ): Promise<void> {
    const current = this.getUserPreferences(userOrRoomId);
    const updated = { ...current, ...preferences };
    this.userPreferences.set(userOrRoomId, updated);

    // Save to persistent storage
    await this.saveUserPreferences();
  }

  /**
   * Load user preferences from storage
   */
  private async loadUserPreferences(): Promise<void> {
    // In a real implementation, this would load from database
    logger.debug('Loading notification preferences...');
  }

  /**
   * Save user preferences to storage
   */
  private async saveUserPreferences(): Promise<void> {
    // In a real implementation, this would save to database
    logger.debug('Saving notification preferences...');
  }

  /**
   * Stop the manager
   */
  async stop() {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }

    // Process any remaining notifications
    await this.processNotificationQueue();

    logger.info('NotificationManager stopped');
  }
}

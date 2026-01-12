import {
  createMessageMemory,
  EventType,
  type IAgentRuntime,
  logger,
  type MessagePayload,
  type UUID,
} from "@elizaos/core";

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
  type: "overdue" | "upcoming" | "daily" | "system";
  priority?: "low" | "medium" | "high";
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
    this.startQueueProcessor();
    await this.loadUserPreferences();

    logger.info("NotificationManager initialized");
  }

  private startQueueProcessor() {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
    }

    this.queueTimer = setInterval(() => this.processNotificationQueue(), 1000);
  }

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
    } finally {
      this.isProcessing = false;
    }
  }

  public async queueNotification(notification: NotificationData) {
    if (this.isInQuietHours(notification.roomId)) {
      logger.debug("Notification queued for after quiet hours:", notification.title);
      return;
    }

    this.notificationQueue.push(notification);
  }

  private async sendNotification(notification: NotificationData) {
    try {
      await this.sendInAppNotification(notification);

      if (this.shouldSendBrowserNotification(notification)) {
        await this.sendBrowserNotification(notification);
      }

      logger.info(
        {
          type: notification.type,
          priority: notification.priority,
        },
        `Notification sent: ${notification.title}`
      );
    } catch (error) {
      logger.error(
        "Error sending notification:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async sendInAppNotification(notification: NotificationData) {
    if (!notification.roomId) return;

    const message = createMessageMemory({
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: notification.roomId,
      content: {
        text: `🔔 ${notification.title}\n\n${notification.body}`,
        source: "NOTIFICATION_MANAGER",
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
      source: "NOTIFICATION_MANAGER",
    };

    await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, payload);
  }

  private async sendBrowserNotification(notification: NotificationData) {
    logger.debug(
      {
        title: notification.title,
        body: notification.body,
        type: notification.type,
      },
      "Browser notification would be sent"
    );
  }

  private shouldSendBrowserNotification(notification: NotificationData): boolean {
    if (!notification.roomId) return false;

    const prefs = this.getUserPreferences(notification.roomId);
    if (!prefs.enabled || !prefs.browserNotifications) return false;

    // Check if this type of reminder is enabled
    switch (notification.type) {
      case "overdue":
        return prefs.reminderTypes.overdue;
      case "upcoming":
        return prefs.reminderTypes.upcoming;
      case "daily":
        return prefs.reminderTypes.daily;
      case "system":
        return true;
      default:
        return false;
    }
  }

  private isInQuietHours(roomId?: UUID): boolean {
    if (!roomId) return false;

    const prefs = this.getUserPreferences(roomId);
    if (!prefs.quietHours) return false;

    const now = new Date();
    const currentHour = now.getHours();
    const { start, end } = prefs.quietHours;

    if (start <= end) {
      return currentHour >= start && currentHour < end;
    } else {
      return currentHour >= start || currentHour < end;
    }
  }

  public getUserPreferences(userOrRoomId: UUID): NotificationPreferences {
    const existing = this.userPreferences.get(userOrRoomId);
    if (existing) return existing;

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

  public async updateUserPreferences(
    userOrRoomId: UUID,
    preferences: Partial<NotificationPreferences>
  ): Promise<void> {
    const current = this.getUserPreferences(userOrRoomId);
    const updated = { ...current, ...preferences };
    this.userPreferences.set(userOrRoomId, updated);

    await this.saveUserPreferences();
  }

  private async loadUserPreferences(): Promise<void> {
    logger.debug("Loading notification preferences...");
  }

  private async saveUserPreferences(): Promise<void> {
    logger.debug("Saving notification preferences...");
  }

  async stop() {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }

    await this.processNotificationQueue();

    logger.info("NotificationManager stopped");
  }
}

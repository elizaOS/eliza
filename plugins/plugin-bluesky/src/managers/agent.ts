import { logger, type IAgentRuntime } from '@elizaos/core';
import { BlueSkyClient } from '../client.js';
import { BlueSkyConfig } from '../common/types.js';
import {
  getPollInterval,
  getActionInterval,
  isPostingEnabled,
  shouldPostImmediately,
  getPostIntervalRange,
  getMaxActionsProcessing,
  isDMsEnabled,
} from '../common/config.js';

export class BlueSkyAgentManager {
  private pollInterval: NodeJS.Timeout | null = null;
  private actionInterval: NodeJS.Timeout | null = null;
  private postInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastSeenNotificationTime: string | null = null;

  constructor(
    public readonly runtime: IAgentRuntime,
    public readonly config: BlueSkyConfig,
    public readonly client: BlueSkyClient
  ) {}

  /**
   * Start the agent manager
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('BlueSky agent manager already running', { agentId: this.runtime.agentId });
      return;
    }

    try {
      // Authenticate the client
      await this.client.authenticate();

      this.isRunning = true;
      logger.info('Starting BlueSky agent manager', { agentId: this.runtime.agentId });

      // Start polling for notifications
      this.startNotificationPolling();

      // Start action processing
      if (this.config.enableActionProcessing) {
        this.startActionProcessing();
      }

      // Start automated posting if enabled
      if (isPostingEnabled(this.runtime)) {
        this.startAutomatedPosting();
      }

      logger.success('BlueSky agent manager started', { agentId: this.runtime.agentId });
    } catch (error) {
      logger.error('Failed to start BlueSky agent manager', { error });
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the agent manager
   */
  async stop(): Promise<void> {
    logger.info('Stopping BlueSky agent manager', { agentId: this.runtime.agentId });

    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.actionInterval) {
      clearInterval(this.actionInterval);
      this.actionInterval = null;
    }

    if (this.postInterval) {
      clearInterval(this.postInterval);
      this.postInterval = null;
    }

    await this.client.cleanup();

    logger.success('BlueSky agent manager stopped', { agentId: this.runtime.agentId });
  }

  /**
   * Start polling for notifications
   */
  private startNotificationPolling(): void {
    const pollInterval = getPollInterval(this.runtime);

    logger.info('Starting notification polling', {
      agentId: this.runtime.agentId,
      interval: pollInterval,
    });

    // Initial poll
    this.pollNotifications();

    // Set up recurring poll
    this.pollInterval = setInterval(() => {
      if (this.isRunning) {
        this.pollNotifications();
      }
    }, pollInterval);
  }

  /**
   * Poll for new notifications
   */
  private async pollNotifications(): Promise<void> {
    try {
      const { notifications } = await this.client.getNotifications(50);

      if (notifications.length === 0) {
        return;
      }

      // Filter new notifications
      const newNotifications = this.lastSeenNotificationTime
        ? notifications.filter((n) => n.indexedAt > this.lastSeenNotificationTime!)
        : notifications;

      if (newNotifications.length > 0) {
        logger.info('Found new notifications', {
          count: newNotifications.length,
          agentId: this.runtime.agentId,
        });

        // Update last seen time
        this.lastSeenNotificationTime = notifications[0].indexedAt;

        // Process each notification
        for (const notification of newNotifications) {
          await this.processNotification(notification);
        }

        // Mark notifications as seen
        await this.client.updateSeenNotifications();
      }
    } catch (error) {
      logger.error('Failed to poll notifications', { error });
    }
  }

  /**
   * Process a single notification
   */
  private async processNotification(notification: any): Promise<void> {
    try {
      logger.debug('Processing notification', {
        type: notification.reason,
        uri: notification.uri,
        author: notification.author.handle,
      });

      // Emit events based on notification type
      switch (notification.reason) {
        case 'mention':
        case 'reply':
          this.runtime.emitEvent('bluesky.mention_received', {
            runtime: this.runtime,
            notification,
            source: 'bluesky',
          });
          break;

        case 'follow':
          this.runtime.emitEvent('bluesky.follow_received', {
            runtime: this.runtime,
            notification,
            source: 'bluesky',
          });
          break;

        case 'like':
          this.runtime.emitEvent('bluesky.like_received', {
            runtime: this.runtime,
            notification,
            source: 'bluesky',
          });
          break;

        case 'repost':
          this.runtime.emitEvent('bluesky.repost_received', {
            runtime: this.runtime,
            notification,
            source: 'bluesky',
          });
          break;

        case 'quote':
          this.runtime.emitEvent('bluesky.quote_received', {
            runtime: this.runtime,
            notification,
            source: 'bluesky',
          });
          break;

        default:
          logger.debug('Unhandled notification type', {
            type: notification.reason,
            notification,
          });
      }
    } catch (error) {
      logger.error('Failed to process notification', { error, notification });
    }
  }

  /**
   * Start action processing
   */
  private startActionProcessing(): void {
    const actionInterval = getActionInterval(this.runtime);

    logger.info('Starting action processing', {
      agentId: this.runtime.agentId,
      interval: actionInterval,
    });

    // Initial action processing
    this.processActions();

    // Set up recurring action processing
    this.actionInterval = setInterval(() => {
      if (this.isRunning) {
        this.processActions();
      }
    }, actionInterval);
  }

  /**
   * Process pending actions
   */
  private async processActions(): Promise<void> {
    try {
      const maxActions = getMaxActionsProcessing(this.runtime);

      // Get recent mentions to respond to
      const { notifications } = await this.client.getNotifications(maxActions);
      const mentionNotifications = notifications.filter(
        (n) => n.reason === 'mention' || n.reason === 'reply'
      );

      logger.debug('Processing actions', {
        mentionCount: mentionNotifications.length,
        agentId: this.runtime.agentId,
      });

      // Process each mention
      for (const notification of mentionNotifications) {
        // Check if we've already responded
        // In a real implementation, we'd track this in memory/database

        // Emit an event for the runtime to handle the response
        this.runtime.emitEvent('bluesky.should_respond', {
          runtime: this.runtime,
          notification,
          source: 'bluesky',
        });
      }
    } catch (error) {
      logger.error('Failed to process actions', { error });
    }
  }

  /**
   * Start automated posting
   */
  private startAutomatedPosting(): void {
    if (shouldPostImmediately(this.runtime)) {
      // Post immediately
      this.createAutomatedPost();
    }

    // Schedule next post
    this.scheduleNextPost();
  }

  /**
   * Schedule the next automated post
   */
  private scheduleNextPost(): void {
    const { min, max } = getPostIntervalRange(this.runtime);
    const interval = Math.random() * (max - min) + min;

    logger.info('Scheduling next post', {
      agentId: this.runtime.agentId,
      intervalMs: interval,
      intervalMinutes: Math.round(interval / 60000),
    });

    this.postInterval = setTimeout(() => {
      if (this.isRunning) {
        this.createAutomatedPost();
        this.scheduleNextPost();
      }
    }, interval);
  }

  /**
   * Create an automated post
   */
  private async createAutomatedPost(): Promise<void> {
    try {
      logger.info('Creating automated post', { agentId: this.runtime.agentId });

      // Emit event for the runtime to handle post creation
      this.runtime.emitEvent('bluesky.create_post', {
        runtime: this.runtime,
        source: 'bluesky',
        automated: true,
      });
    } catch (error) {
      logger.error('Failed to create automated post', { error });
    }
  }
}

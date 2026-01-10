/**
 * BlueSky agent manager for polling and automated actions.
 */

import { logger, type IAgentRuntime } from "@elizaos/core";
import { BlueSkyClient } from "../client";
import type { BlueSkyConfig, BlueSkyNotification, NotificationReason } from "../types";
import {
  getPollInterval,
  getActionInterval,
  isPostingEnabled,
  shouldPostImmediately,
  getPostIntervalRange,
  getMaxActionsProcessing,
} from "../utils/config";

export class BlueSkyAgentManager {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private actionTimer: ReturnType<typeof setInterval> | null = null;
  private postTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastSeenAt: string | null = null;

  constructor(
    public readonly runtime: IAgentRuntime,
    public readonly config: BlueSkyConfig,
    public readonly client: BlueSkyClient
  ) {}

  async start(): Promise<void> {
    if (this.running) return;

    await this.client.authenticate();
    this.running = true;

    this.startNotificationPolling();

    if (this.config.enableActionProcessing) {
      this.startActionProcessing();
    }

    if (isPostingEnabled(this.runtime)) {
      this.startAutomatedPosting();
    }

    logger.success("BlueSky agent manager started", { agentId: this.runtime.agentId });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.actionTimer) clearInterval(this.actionTimer);
    if (this.postTimer) clearTimeout(this.postTimer);

    this.pollTimer = null;
    this.actionTimer = null;
    this.postTimer = null;

    await this.client.cleanup();
    logger.info("BlueSky agent manager stopped", { agentId: this.runtime.agentId });
  }

  private startNotificationPolling(): void {
    const interval = getPollInterval(this.runtime);
    this.pollNotifications();
    this.pollTimer = setInterval(() => this.pollNotifications(), interval);
  }

  private async pollNotifications(): Promise<void> {
    if (!this.running) return;

    const { notifications } = await this.client.getNotifications(50);
    if (notifications.length === 0) return;

    const newNotifications = this.lastSeenAt
      ? notifications.filter((n) => n.indexedAt > this.lastSeenAt!)
      : notifications;

    if (newNotifications.length > 0) {
      this.lastSeenAt = notifications[0].indexedAt;

      for (const notification of newNotifications) {
        this.emitNotificationEvent(notification);
      }

      await this.client.updateSeenNotifications();
    }
  }

  private emitNotificationEvent(notification: BlueSkyNotification): void {
    const eventMap: Record<NotificationReason, string> = {
      mention: "bluesky.mention_received",
      reply: "bluesky.mention_received",
      follow: "bluesky.follow_received",
      like: "bluesky.like_received",
      repost: "bluesky.repost_received",
      quote: "bluesky.quote_received",
    };

    const event = eventMap[notification.reason];
    if (event) {
      this.runtime.emitEvent(event, {
        runtime: this.runtime,
        notification,
        source: "bluesky",
      });
    }
  }

  private startActionProcessing(): void {
    const interval = getActionInterval(this.runtime);
    this.processActions();
    this.actionTimer = setInterval(() => this.processActions(), interval);
  }

  private async processActions(): Promise<void> {
    if (!this.running) return;

    const max = getMaxActionsProcessing(this.runtime);
    const { notifications } = await this.client.getNotifications(max);

    for (const notification of notifications) {
      if (notification.reason === "mention" || notification.reason === "reply") {
        this.runtime.emitEvent("bluesky.should_respond", {
          runtime: this.runtime,
          notification,
          source: "bluesky",
        });
      }
    }
  }

  private startAutomatedPosting(): void {
    if (shouldPostImmediately(this.runtime)) {
      this.createAutomatedPost();
    }
    this.scheduleNextPost();
  }

  private scheduleNextPost(): void {
    const { min, max } = getPostIntervalRange(this.runtime);
    const interval = Math.random() * (max - min) + min;

    this.postTimer = setTimeout(() => {
      if (this.running) {
        this.createAutomatedPost();
        this.scheduleNextPost();
      }
    }, interval);
  }

  private createAutomatedPost(): void {
    this.runtime.emitEvent("bluesky.create_post", {
      runtime: this.runtime,
      source: "bluesky",
      automated: true,
    });
  }
}

/**
 * ElizaClient extension for the notification inbox: list, unread count, and
 * mark-read verbs backing the notification store.
 */
import type {
  AgentNotification,
  NotificationCategory,
  NotificationInput,
} from "@elizaos/core";
import { ElizaClient } from "./client-base";

export interface NotificationListResponse {
  notifications: AgentNotification[];
  unreadCount: number;
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  category?: NotificationCategory;
  limit?: number;
}

declare module "./client-base" {
  interface ElizaClient {
    listNotifications(
      opts?: ListNotificationsOptions,
    ): Promise<NotificationListResponse>;
    createNotification(
      input: NotificationInput,
    ): Promise<{ notification: AgentNotification }>;
    markNotificationRead(id: string): Promise<{ ok: boolean }>;
    markAllNotificationsRead(): Promise<{ changed: number }>;
    removeNotification(id: string): Promise<{ ok: boolean }>;
    clearNotifications(): Promise<{ ok: boolean }>;
  }
}

ElizaClient.prototype.listNotifications = async function (
  this: ElizaClient,
  opts?: ListNotificationsOptions,
): Promise<NotificationListResponse> {
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set("unreadOnly", "true");
  if (opts?.category) params.set("category", opts.category);
  if (typeof opts?.limit === "number") params.set("limit", String(opts.limit));
  const query = params.toString();
  return this.fetch<NotificationListResponse>(
    `/api/notifications${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.createNotification = async function (
  this: ElizaClient,
  input: NotificationInput,
): Promise<{ notification: AgentNotification }> {
  return this.fetch<{ notification: AgentNotification }>("/api/notifications", {
    method: "POST",
    body: JSON.stringify(input),
  });
};

ElizaClient.prototype.markNotificationRead = async function (
  this: ElizaClient,
  id: string,
): Promise<{ ok: boolean }> {
  return this.fetch<{ ok: boolean }>(
    `/api/notifications/${encodeURIComponent(id)}/read`,
    { method: "POST" },
  );
};

ElizaClient.prototype.markAllNotificationsRead = async function (
  this: ElizaClient,
): Promise<{ changed: number }> {
  return this.fetch<{ changed: number }>("/api/notifications/read-all", {
    method: "POST",
  });
};

ElizaClient.prototype.removeNotification = async function (
  this: ElizaClient,
  id: string,
): Promise<{ ok: boolean }> {
  return this.fetch<{ ok: boolean }>(
    `/api/notifications/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.clearNotifications = async function (
  this: ElizaClient,
): Promise<{ ok: boolean }> {
  return this.fetch<{ ok: boolean }>("/api/notifications", {
    method: "DELETE",
  });
};

import type { WebhookEvent } from "@stwd/shared";

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  attempts: number;
  error?: string;
  deliveredAt?: Date;
}

export interface WebhookConfig {
  url: string;
  secret: string;
  events?: Array<WebhookEvent["type"] | string>;
}

export interface WebhookDispatcherOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface RetryQueueOptions {
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface QueuedWebhookDelivery {
  event: WebhookEvent;
  webhook: WebhookConfig | string;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
}

export interface RetryQueueStats {
  pending: number;
  delivered: number;
  failed: number;
}

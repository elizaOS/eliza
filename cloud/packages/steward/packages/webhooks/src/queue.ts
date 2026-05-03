import type { WebhookEvent } from "@stwd/shared";

import { WebhookDispatcher } from "./dispatcher";
import type {
  QueuedWebhookDelivery,
  RetryQueueOptions,
  RetryQueueStats,
  WebhookConfig,
  WebhookDeliveryResult,
} from "./types";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export class RetryQueue {
  private readonly dispatcher: WebhookDispatcher;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly pending = new Map<string, QueuedWebhookDelivery>();
  private delivered = 0;
  private failed = 0;

  constructor(
    dispatcher = new WebhookDispatcher({ maxRetries: 0 }),
    options: RetryQueueOptions = {},
  ) {
    this.dispatcher = dispatcher;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  enqueue(event: WebhookEvent, webhook: WebhookConfig | string): string {
    const id = `${event.tenantId}:${event.agentId}:${event.type}:${Date.now()}:${this.pending.size}`;

    this.pending.set(id, {
      event,
      webhook,
      attempts: 0,
      nextAttemptAt: new Date(),
    });

    return id;
  }

  async processQueue(): Promise<WebhookDeliveryResult[]> {
    const results: WebhookDeliveryResult[] = [];
    const now = Date.now();

    for (const [id, delivery] of [...this.pending.entries()]) {
      if (delivery.nextAttemptAt.getTime() > now) {
        continue;
      }

      const result = await this.dispatcher.dispatch(delivery.event, delivery.webhook);
      delivery.attempts += 1;

      if (result.success) {
        this.pending.delete(id);
        this.delivered += 1;
        results.push(result);
        continue;
      }

      delivery.lastError = result.error;

      if (delivery.attempts >= this.maxRetries) {
        this.pending.delete(id);
        this.failed += 1;
        results.push({
          ...result,
          attempts: delivery.attempts,
        });
        continue;
      }

      delivery.nextAttemptAt = new Date(
        Date.now() + this.retryDelayMs * 2 ** (delivery.attempts - 1),
      );
      this.pending.set(id, delivery);
      results.push({
        ...result,
        attempts: delivery.attempts,
      });
    }

    return results;
  }

  getStats(): RetryQueueStats {
    return {
      pending: this.pending.size,
      delivered: this.delivered,
      failed: this.failed,
    };
  }
}

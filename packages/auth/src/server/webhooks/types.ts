import type { LookupFunction } from "node:net";
import type { WebhookEvent } from "../shared/index.ts";

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  attempts: number;
  error?: string;
  deliveredAt?: Date;
  /** Stable delivery id (nonce) used in the signature; reused across retries. */
  deliveryId?: string;
}

export interface WebhookConfig {
  id?: string;
  url: string;
  secret: string;
  events?: Array<WebhookEvent["type"] | string>;
}

export interface WebhookDispatcherOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
  allowInsecureHttp?: boolean;
  lookup?: LookupFunction;
}

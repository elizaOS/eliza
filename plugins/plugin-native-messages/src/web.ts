import { WebPlugin } from "@capacitor/core";

import type {
  ListMessagesOptions,
  MessagesPlugin,
  SendSmsOptions,
  SendSmsResult,
  SmsMessageSummary,
} from "./definitions";

function validateSendSmsOptions(options: SendSmsOptions): void {
  const address =
    typeof options?.address === "string" ? options.address.trim() : "";
  const body = typeof options?.body === "string" ? options.body.trim() : "";
  if (!address) {
    throw new Error("address is required");
  }
  if (!body) {
    throw new Error("body is required");
  }
}

function normalizeListLimit(limit: unknown): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error("limit must be between 1 and 500");
  }
  const normalized = Math.trunc(limit);
  if (normalized < 1 || normalized > 500) {
    throw new Error("limit must be between 1 and 500");
  }
  return normalized;
}

export class MessagesWeb extends WebPlugin implements MessagesPlugin {
  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    validateSendSmsOptions(options);
    throw new Error("SMS is only available on Android.");
  }

  async listMessages(
    options?: ListMessagesOptions,
  ): Promise<{ messages: SmsMessageSummary[] }> {
    normalizeListLimit(options?.limit);
    return { messages: [] };
  }
}

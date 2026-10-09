/** Validates SMS bridge inputs and exposes the browser unavailable fallback. */
import { WebPlugin } from "@capacitor/core";

import type {
  ListMessagesOptions,
  MessagesPermissionStatus,
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

function validateListLimit(limit: unknown): void {
  if (limit === undefined) return;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > 2_147_483_647
  ) {
    throw new Error("limit must be a positive 32-bit integer");
  }
}

export class MessagesWeb extends WebPlugin implements MessagesPlugin {
  async sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
    validateSendSmsOptions(options);
    throw new Error("SMS is only available on Android.");
  }

  async listMessages(
    options?: ListMessagesOptions,
  ): Promise<{ messages: SmsMessageSummary[] }> {
    validateListLimit(options?.limit);
    return { messages: [] };
  }

  // Web has no SMS permission model; report granted so the shared view flow
  // proceeds (sendSms throws / listMessages returns empty on web anyway).
  async checkPermissions(): Promise<MessagesPermissionStatus> {
    return { sms: "granted" };
  }

  async requestPermissions(): Promise<MessagesPermissionStatus> {
    return { sms: "granted" };
  }
}

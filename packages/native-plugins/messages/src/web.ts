import { WebPlugin } from "@capacitor/core";

import type {
  ListMessagesOptions,
  MessagesPlugin,
  SendSmsOptions,
  SmsMessageSummary,
} from "./definitions";

export class MessagesWeb extends WebPlugin implements MessagesPlugin {
  async sendSms(_options: SendSmsOptions): Promise<void> {
    throw new Error("SMS is only available on Android.");
  }

  async listMessages(_options?: ListMessagesOptions): Promise<{ messages: SmsMessageSummary[] }> {
    return { messages: [] };
  }
}

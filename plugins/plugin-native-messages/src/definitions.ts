export interface SendSmsOptions {
  address: string;
  body: string;
}

export interface SmsMessageSummary {
  id: string;
  threadId: string;
  address: string;
  body: string;
  date: number;
  type: number;
  read: boolean;
}

export interface SendSmsResult {
  messageId: string;
  messageUri: string;
}

export interface ListMessagesOptions {
  limit?: number;
  threadId?: string;
}

export interface MessagesPlugin {
  sendSms(options: SendSmsOptions): Promise<SendSmsResult>;
  listMessages(
    options?: ListMessagesOptions,
  ): Promise<{ messages: SmsMessageSummary[] }>;
}

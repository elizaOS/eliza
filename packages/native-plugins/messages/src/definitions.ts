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

export interface ListMessagesOptions {
  limit?: number;
  threadId?: string;
}

export interface MessagesPlugin {
  sendSms(options: SendSmsOptions): Promise<void>;
  listMessages(options?: ListMessagesOptions): Promise<{ messages: SmsMessageSummary[] }>;
}

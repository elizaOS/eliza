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
  /** Current SMS (READ_SMS/SEND_SMS) permission state. Web: granted. */
  checkPermissions(): Promise<MessagesPermissionStatus>;
  /** Prompt for SMS access (no-op grant on web). Feature-gated to the Messages
   *  view; never requested at launch. */
  requestPermissions(): Promise<MessagesPermissionStatus>;
}

/** Runtime permission state for the SMS (READ_SMS/SEND_SMS) alias. */
export interface MessagesPermissionStatus {
  sms: import("@capacitor/core").PermissionState;
}

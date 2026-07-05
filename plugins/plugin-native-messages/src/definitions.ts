/**
 * Type definitions for the `@elizaos/capacitor-messages` bridge.
 *
 * The native side is implemented in Kotlin under
 * `android/src/main/java/ai/eliza/plugins/messages/MessagesPlugin.kt` and
 * registered with Capacitor as `ElizaMessages`, wrapping Android's
 * `SmsManager` (send) and `content://sms` provider (read). The web fallback
 * in `./web.ts` throws on `sendSms` and resolves empty from `listMessages`
 * rather than emulating SMS in the browser.
 */

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

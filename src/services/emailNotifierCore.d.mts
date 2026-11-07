export interface NotificationContext { userId: string; tenantId: string; }
export interface VerifiedNotificationUser { id: string; tenantId: string; email: string; emailVerified: boolean; notificationsEnabled: boolean; }
export interface EmailAlertPayload {
  to?: string;
  subject: string;
  body: string;
  level: "INFO" | "REPAIR_ALERT" | "CRITICAL_DRIFT" | "USER_NOTIFICATION";
  audience?: "user" | "admin";
}
export interface NotificationOptions {
  env?: Record<string, string | undefined>;
  resolveUser?: (context: NotificationContext) => Promise<VerifiedNotificationUser | null>;
  authorizeAdmin?: (context: NotificationContext) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}
/** Server-only. resolveUser must look up verified persisted account/job ownership.
 * Bare email strings are accepted only for migration compatibility and always return false.
 * true means provider accepted a message ID, not confirmed inbox delivery.
 */
export class EmailNotifier {
  constructor(options?: NotificationOptions);
  resolveRecipient(email?: string, audience?: "user" | "admin"): string | null;
  sendEmail(payload: EmailAlertPayload, context?: NotificationContext | string): Promise<boolean>;
}

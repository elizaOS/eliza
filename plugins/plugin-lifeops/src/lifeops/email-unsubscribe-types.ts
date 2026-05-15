export type EmailUnsubscribeMethod =
  | "http_one_click"
  | "http_post"
  | "http_get"
  | "mailto"
  | "manual_only";

export type EmailUnsubscribeStatus =
  | "succeeded"
  | "failed"
  | "blocked_no_mechanism"
  | "manual_required";

export interface EmailSubscriptionSender {
  senderEmail: string;
  senderDisplay: string;
  senderDomain: string | null;
  listId: string | null;
  messageCount: number;
  firstSeenAt: string;
  latestSeenAt: string;
  unsubscribeMethod: EmailUnsubscribeMethod;
  unsubscribeHttpUrl: string | null;
  unsubscribeMailto: string | null;
  listUnsubscribePost: string | null;
  sampleSubjects: string[];
  latestMessageId: string;
  latestThreadId: string;
  allMessageIds: string[];
  allThreadIds: string[];
}

export interface EmailSubscriptionScanSummary {
  scannedMessageCount: number;
  uniqueSenderCount: number;
  oneClickEligibleCount: number;
  mailtoOnlyCount: number;
  manualOnlyCount: number;
}

export interface EmailSubscriptionScanResult {
  syncedAt: string;
  query: string;
  summary: EmailSubscriptionScanSummary;
  senders: EmailSubscriptionSender[];
}

export interface EmailUnsubscribeRecord {
  id: string;
  agentId: string;
  senderEmail: string;
  senderDisplay: string;
  senderDomain: string | null;
  listId: string | null;
  method: EmailUnsubscribeMethod;
  status: EmailUnsubscribeStatus;
  httpStatusCode: number | null;
  httpFinalUrl: string | null;
  filterCreated: boolean;
  filterId: string | null;
  threadsTrashed: number;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EmailUnsubscribeScanRequest {
  query?: string | null;
  maxMessages?: number | null;
}

export interface EmailUnsubscribeRequest {
  senderEmail: string;
  listId?: string | null;
  blockAfter?: boolean | null;
  trashExisting?: boolean | null;
  confirmed?: boolean | null;
}

export interface EmailUnsubscribeResult {
  record: EmailUnsubscribeRecord;
}

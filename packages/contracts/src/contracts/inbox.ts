/**
 * Inbox contract types: auto-reply configuration and triage rules that classify
 * inbound messages (urgent/ignore/notify). Consumed by the inbox surface and the
 * agent-defaults config (`InboxTriageConfig`).
 */
export interface InboxAutoReplyConfig {
  enabled?: boolean;
  confidenceThreshold?: number;
  senderWhitelist?: string[];
  channelWhitelist?: string[];
  maxAutoRepliesPerHour?: number;
}

export interface InboxTriageRules {
  alwaysUrgent?: string[];
  alwaysIgnore?: string[];
  alwaysNotify?: string[];
}

export interface InboxTriageConfig {
  enabled?: boolean;
  triageCron?: string;
  digestCron?: string;
  digestTimezone?: string;
  channels?: string[];
  prioritySenders?: string[];
  priorityChannels?: string[];
  autoReply?: InboxAutoReplyConfig;
  triageRules?: InboxTriageRules;
  digestDeliveryChannel?: string;
  retentionDays?: number;
}

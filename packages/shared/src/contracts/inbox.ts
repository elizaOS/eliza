export interface InboxAutoReplyConfig {
  enabled?: boolean;
  /** Minimum LLM confidence (0-1) for auto-reply. Default: 0.85. */
  confidenceThreshold?: number;
  /** Only auto-reply to these senders (empty = all eligible). */
  senderWhitelist?: string[];
  /** Only auto-reply in these channels (empty = all eligible). */
  channelWhitelist?: string[];
  /** Rate limit: max auto-replies per hour. Default: 5. */
  maxAutoRepliesPerHour?: number;
}

export interface InboxTriageRules {
  /** Patterns that always classify as urgent (e.g. "keyword:urgent", "sender:id"). */
  alwaysUrgent?: string[];
  /** Patterns that always classify as ignore. */
  alwaysIgnore?: string[];
  /** Patterns that always classify as notify. */
  alwaysNotify?: string[];
}

export interface InboxTriageConfig {
  enabled?: boolean;
  /** Cron expression for periodic triage (default: "0 * * * *" = hourly). */
  triageCron?: string;
  /** Cron expression for daily digest (default: "0 8 * * *" = 8am). */
  digestCron?: string;
  /** Timezone for cron expressions. */
  digestTimezone?: string;
  /** Which channels to triage. Default: all connected. */
  channels?: string[];
  /** Senders that should be treated as high priority. */
  prioritySenders?: string[];
  /** Channels that should be treated as high priority. */
  priorityChannels?: string[];
  /** Auto-reply configuration. */
  autoReply?: InboxAutoReplyConfig;
  /** Rule-based triage overrides. */
  triageRules?: InboxTriageRules;
  /** Channel to deliver daily digest to. Default: "client_chat". */
  digestDeliveryChannel?: string;
  /** Days to retain triage entries before cleanup. Default: 30. */
  retentionDays?: number;
}

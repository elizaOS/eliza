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

import { loadElizaConfig } from "@elizaos/agent";
import type { InboxTriageConfig } from "./types.js";

/**
 * Load inbox triage configuration from the agent config file.
 * Falls back to sensible defaults when not configured.
 */
export function loadInboxTriageConfig(): InboxTriageConfig {
  try {
    const cfg = loadElizaConfig();
    const raw = cfg.agents?.defaults?.inboxTriage as
      | Partial<InboxTriageConfig>
      | undefined;
    if (raw && typeof raw === "object") {
      return deepMergeConfig(DEFAULT_CONFIG, raw);
    }
  } catch {
    // Config loading failed; use defaults
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Deep-merge user overrides onto defaults so nested objects (autoReply,
 * triageRules) keep their default fields when the user only sets a subset.
 */
function deepMergeConfig(
  defaults: InboxTriageConfig,
  overrides: Partial<InboxTriageConfig>,
): InboxTriageConfig {
  return {
    ...defaults,
    ...overrides,
    autoReply: {
      ...defaults.autoReply,
      ...(overrides.autoReply ?? {}),
    },
    triageRules: {
      ...defaults.triageRules,
      ...(overrides.triageRules ?? {}),
    },
  };
}

const DEFAULT_CONFIG: InboxTriageConfig = {
  enabled: false,
  triageCron: "0 * * * *",
  digestCron: "0 8 * * *",
  digestTimezone: undefined,
  channels: [
    "discord",
    "telegram",
    "signal",
    "imessage",
    "whatsapp",
    "gmail",
    "x_dm",
  ],
  prioritySenders: [],
  priorityChannels: [],
  autoReply: {
    enabled: false,
    confidenceThreshold: 0.85,
    senderWhitelist: [],
    channelWhitelist: [],
    maxAutoRepliesPerHour: 5,
  },
  triageRules: {
    alwaysUrgent: [],
    alwaysIgnore: [],
    alwaysNotify: [],
  },
  digestDeliveryChannel: "client_chat",
  retentionDays: 30,
};

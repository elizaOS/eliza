/**
 * Loads inbox triage defaults plus optional owner/agent overrides from the
 * agent config. Nested settings are deep-merged so partial auto-reply or rule
 * overrides do not erase the plugin's default safety thresholds.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { InboxTriageConfig } from "./types.js";

const INBOX_TRIAGE_CONFIG_SETTING = "ELIZA_INBOX_TRIAGE_CONFIG_JSON";

export function loadInboxTriageConfig(
  runtime?: Pick<IAgentRuntime, "getSetting">,
): InboxTriageConfig {
  const raw =
    typeof runtime?.getSetting === "function"
      ? runtime.getSetting(INBOX_TRIAGE_CONFIG_SETTING)
      : null;
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as Partial<InboxTriageConfig>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return deepMergeConfig(DEFAULT_CONFIG, parsed);
      }
    } catch {
      // error-policy:J3 malformed optional config setting is invalid input; the
      // caller gets the default disabled triage config, not a fake custom config.
    }
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

/**
 * Customize-path question set for first-run.
 *
 * Five questions: Q1/Q2/Q4 always asked; Q3/Q5 conditional. Partial answers
 * are persisted Q-by-Q via `FirstRunStateStore.recordAnswer` so a user can
 * abandon mid-flow and resume without losing progress.
 *
 * Channel-validation for Q4: the chosen channel must be registered AND have
 * a connected dispatcher. If neither is the case the answer is recorded with
 * `fallbackToInApp: true` and a warning surfaces back through the action
 * result. The `ChannelRegistry` is the eventual checker; the local inspector
 * below leans on `getDefaultTriageService` adapter registration as a
 * connectivity proxy.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { OwnerFactWindow } from "./state.js";

export type FirstRunQuestionId =
  | "preferredName"
  | "timezoneAndWindows"
  | "categories"
  | "channel"
  | "relationships";

export interface FirstRunQuestionDefinition {
  id: FirstRunQuestionId;
  prompt: string;
  /** Whether the question should be asked given the current answers. */
  shouldAsk(answers: Record<string, unknown>): boolean;
}

/**
 * Canonical question text. The action's prompt-rendering layer (planner) is
 * responsible for actually asking the user; these strings are the contract
 * the planner reads from.
 */
export const FIRST_RUN_QUESTIONS: readonly FirstRunQuestionDefinition[] = [
  {
    id: "preferredName",
    prompt: "What should I call you?",
    shouldAsk: () => true,
  },
  {
    id: "timezoneAndWindows",
    prompt:
      "What time zone are you in, and what counts as your morning / evening? (Defaults: morning 06:00–11:00, evening 18:00–22:00.)",
    shouldAsk: () => true,
  },
  {
    id: "categories",
    prompt:
      "Which categories sound useful to enable now? (multi-select: sleep tracking, reminder packs, inbox triage, blockers/focus, follow-ups)",
    shouldAsk: () => true,
  },
  {
    id: "channel",
    prompt:
      "Where do you want me to nudge you? (in_app, push, imessage, discord, telegram)",
    shouldAsk: () => true,
  },
  {
    id: "relationships",
    prompt:
      "List 3–5 important relationships and a default cadence (e.g. 'Pat — 14 days; Sam — weekly').",
    shouldAsk: (answers) => {
      const categories = answers.categories;
      if (!Array.isArray(categories)) return false;
      return categories.some(
        (c) => typeof c === "string" && c.toLowerCase() === "follow-ups",
      );
    },
  },
] as const;

export type CustomizeCategory =
  | "sleep tracking"
  | "reminder packs"
  | "inbox triage"
  | "blockers/focus"
  | "follow-ups";

export const CUSTOMIZE_CATEGORIES: readonly CustomizeCategory[] = [
  "sleep tracking",
  "reminder packs",
  "inbox triage",
  "blockers/focus",
  "follow-ups",
];

export interface RelationshipAnswerEntry {
  name: string;
  cadenceDays: number;
}

export interface CustomizeAnswers {
  preferredName: string;
  timezone: string;
  morningWindow: OwnerFactWindow;
  eveningWindow: OwnerFactWindow;
  categories: CustomizeCategory[];
  channel: string;
  channelFallbackToInApp: boolean;
  channelWarning?: string;
  relationships?: RelationshipAnswerEntry[];
}

export const DEFAULT_MORNING_WINDOW: OwnerFactWindow = {
  startLocal: "06:00",
  endLocal: "11:00",
};

export const DEFAULT_EVENING_WINDOW: OwnerFactWindow = {
  startLocal: "18:00",
  endLocal: "22:00",
};

export const SUPPORTED_NOTIFICATION_CHANNELS = [
  "in_app",
  "push",
  "imessage",
  "discord",
  "telegram",
] as const;

export type SupportedNotificationChannel =
  (typeof SUPPORTED_NOTIFICATION_CHANNELS)[number];

export function nextUnansweredQuestion(
  answers: Record<string, unknown>,
): FirstRunQuestionDefinition | null {
  for (const q of FIRST_RUN_QUESTIONS) {
    if (!q.shouldAsk(answers)) continue;
    if (answers[q.id] === undefined) return q;
  }
  return null;
}

// --- Validators / parsers --------------------------------------------------

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parsePreferredName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return null;
  return trimmed;
}

export function parseTimeWindow(value: unknown): OwnerFactWindow | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.startLocal !== "string" ||
    typeof v.endLocal !== "string" ||
    !TIME_OF_DAY_PATTERN.test(v.startLocal) ||
    !TIME_OF_DAY_PATTERN.test(v.endLocal) ||
    v.startLocal >= v.endLocal
  ) {
    return null;
  }
  return { startLocal: v.startLocal, endLocal: v.endLocal };
}

export function parseTimezone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  // RFC-grade timezone validation lives at the OwnerFactStore layer; for
  // first-run we accept any non-empty string and trust the IANA name.
  // Catastrophically wrong names surface later via downstream resolution.
  return trimmed;
}

export function parseCategories(value: unknown): CustomizeCategory[] | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set<string>(CUSTOMIZE_CATEGORIES);
  const out: CustomizeCategory[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (allowed.has(normalized)) {
      out.push(normalized as CustomizeCategory);
    }
  }
  return out;
}

export function parseRelationships(
  value: unknown,
): RelationshipAnswerEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: RelationshipAnswerEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const cadenceDays =
      typeof obj.cadenceDays === "number" && obj.cadenceDays > 0
        ? Math.floor(obj.cadenceDays)
        : null;
    if (!name || cadenceDays === null) continue;
    out.push({ name, cadenceDays });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Channel validation (Q4) ---------------------------------------------

export interface ChannelValidationResult {
  channel: string;
  registered: boolean;
  connected: boolean;
  fallbackToInApp: boolean;
  warning?: string;
}

/**
 * Inspector contract — pluggable so the `ChannelRegistry` can replace the
 * default implementation without touching this module.
 */
export interface ChannelInspector {
  isRegistered(channel: string): boolean;
  isConnected(channel: string): boolean;
}

class FallbackChannelInspector implements ChannelInspector {
  isRegistered(channel: string): boolean {
    return SUPPORTED_NOTIFICATION_CHANNELS.includes(
      channel as SupportedNotificationChannel,
    );
  }
  /**
   * Default: treat `in_app` as always connected and other channels as
   * "registered but unconnected" so the validator returns the right fallback
   * warning shape. The real `ChannelRegistry` reads connector status from
   * `ConnectorRegistry`.
   */
  isConnected(channel: string): boolean {
    return channel === "in_app";
  }
}

let activeInspector: ChannelInspector = new FallbackChannelInspector();

export function setChannelInspector(inspector: ChannelInspector | null): void {
  activeInspector = inspector ?? new FallbackChannelInspector();
}

export function validateChannel(
  rawChannel: unknown,
  _runtime: IAgentRuntime,
): ChannelValidationResult {
  const normalized =
    typeof rawChannel === "string" ? rawChannel.trim().toLowerCase() : "";
  if (!normalized) {
    return {
      channel: "in_app",
      registered: true,
      connected: true,
      fallbackToInApp: true,
      warning: "No channel was selected — defaulting to in-app notifications.",
    };
  }
  const registered = activeInspector.isRegistered(normalized);
  if (!registered) {
    return {
      channel: "in_app",
      registered: false,
      connected: true,
      fallbackToInApp: true,
      warning: `Channel "${normalized}" is not registered — falling back to in-app notifications.`,
    };
  }
  const connected = activeInspector.isConnected(normalized);
  if (!connected) {
    return {
      channel: normalized,
      registered: true,
      connected: false,
      fallbackToInApp: true,
      warning: `Channel "${normalized}" is registered but not yet connected — your reminders will fall back to in-app until you connect it.`,
    };
  }
  return {
    channel: normalized,
    registered: true,
    connected: true,
    fallbackToInApp: false,
  };
}

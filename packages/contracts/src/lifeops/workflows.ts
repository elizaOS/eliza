/** LifeOps workflows contracts. Persisted and wire shapes are preserved. */

import type { GetLifeOpsCalendarFeedRequest } from "../calendar.js";
import type { LifeOpsEventFilters, LifeOpsEventKind } from "./events.js";
import type {
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
} from "./gmail.js";
import type {
  GetLifeOpsHealthSummaryRequest,
  LifeOpsRegularityClass,
} from "./health.js";
import type {
  LifeOpsActor,
  LifeOpsContextPolicy,
  LifeOpsDomain,
  LifeOpsOwnershipInput,
  LifeOpsSubjectType,
  LifeOpsVisibilityScope,
} from "./policy.js";
import type { CreateLifeOpsDefinitionRequest } from "./scheduling.js";

export const LIFEOPS_WORKFLOW_STATUSES = [
  "active",
  "paused",
  "archived",
] as const;

export type LifeOpsWorkflowStatus = (typeof LIFEOPS_WORKFLOW_STATUSES)[number];

export const LIFEOPS_WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "success",
  "failed",
  "failed_uncompensated",
  "cancelled",
] as const;

export type LifeOpsWorkflowRunStatus =
  (typeof LIFEOPS_WORKFLOW_RUN_STATUSES)[number];

export const LIFEOPS_WORKFLOW_TRIGGER_TYPES = [
  "manual",
  "schedule",
  "event",
] as const;

export type LifeOpsWorkflowTriggerType =
  (typeof LIFEOPS_WORKFLOW_TRIGGER_TYPES)[number];

export const LIFEOPS_WEBSITE_ACCESS_UNLOCK_MODES = [
  "fixed_duration",
  "until_manual_lock",
  "until_callback",
] as const;

export type LifeOpsWebsiteAccessUnlockMode =
  (typeof LIFEOPS_WEBSITE_ACCESS_UNLOCK_MODES)[number];

export interface LifeOpsWebsiteAccessPolicy {
  groupKey: string;
  websites: string[];
  unlockMode: LifeOpsWebsiteAccessUnlockMode;
  unlockDurationMinutes?: number;
  callbackKey?: string | null;
  reason: string;
}

export interface LifeOpsWorkflowDefinition {
  id: string;
  agentId: string;
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
  title: string;
  triggerType: LifeOpsWorkflowTriggerType;
  schedule: LifeOpsWorkflowSchedule;
  actionPlan: LifeOpsWorkflowActionPlan;
  permissionPolicy: LifeOpsWorkflowPermissionPolicy;
  status: LifeOpsWorkflowStatus;
  createdBy: LifeOpsActor;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsWorkflowRun {
  id: string;
  agentId: string;
  workflowId: string;
  idempotencyKey: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: LifeOpsWorkflowRunStatus;
  result: Record<string, unknown>;
  auditRef: string | null;
}

export type LifeOpsWorkflowSchedule =
  | {
      kind: "manual";
    }
  | {
      kind: "once";
      runAt: string;
      timezone: string;
    }
  | {
      kind: "interval";
      everyMinutes: number;
      timezone: string;
    }
  | {
      kind: "cron";
      cronExpression: string;
      timezone: string;
    }
  | {
      kind: "relative_to_wake";
      /** Minutes offset from wake anchor (wake.confirmed). Negative = before. */
      offsetMinutes: number;
      timezone: string;
      onDays?: number[];
      /** Minimum regularity required before projecting an anchor. Default: `regular`. */
      requireRegularityAtLeast?: LifeOpsRegularityClass;
      /**
       * Minutes of sustained awake state after `wake.observed` required before
       * the workflow fires. When set, the resolver waits for a `wake.confirmed`
       * event rather than using the raw wake anchor.
       */
      stabilityWindowMinutes?: number;
    }
  | {
      kind: "relative_to_bedtime";
      offsetMinutes: number;
      timezone: string;
      onDays?: number[];
      requireRegularityAtLeast?: LifeOpsRegularityClass;
    }
  | {
      /**
       * Fires during the canonical "morning" window anchored on the latest
       * wake.confirmed. The window starts at `wakeConfirmedAt` and ends
       * `windowMinutesFromWake` later (default 240). Workflow scheduler emits
       * exactly once per morning window when the workflow becomes eligible.
       */
      kind: "during_morning";
      timezone: string;
      windowMinutesFromWake?: number;
      onDays?: number[];
      requireRegularityAtLeast?: LifeOpsRegularityClass;
    }
  | {
      /**
       * Fires during the canonical "night" window anchored on the projected
       * bedtime target. The window starts `windowMinutesBeforeSleepTarget`
       * before the bedtime target and ends at `sleep.detected`. Fires exactly
       * once per night window when the workflow becomes eligible.
       */
      kind: "during_night";
      timezone: string;
      windowMinutesBeforeSleepTarget?: number;
      onDays?: number[];
      requireRegularityAtLeast?: LifeOpsRegularityClass;
    }
  | {
      kind: "event";
      eventKind: LifeOpsEventKind;
      filters?: LifeOpsEventFilters;
    };

export interface LifeOpsWorkflowPermissionPolicy {
  allowBrowserActions: boolean;
  trustedBrowserActions: boolean;
  allowXPosts: boolean;
  trustedXPosting: boolean;
  requireConfirmationForBrowserActions: boolean;
  requireConfirmationForXPosts: boolean;
}

// Generic browser-companion + packaging contracts live in
// `@elizaos/plugin-browser/contracts`. `LIFEOPS_BROWSER_KINDS`,
// `LifeOpsBrowserKind`, `LIFEOPS_BROWSER_ACTION_KINDS`,
// `LifeOpsBrowserActionKind`, and `LifeOpsBrowserAction` remain here
// because workflow-linked session shapes below still reference them.
export const LIFEOPS_BROWSER_KINDS = ["chrome", "firefox", "safari"] as const;

export type LifeOpsBrowserKind = (typeof LIFEOPS_BROWSER_KINDS)[number];

export const LIFEOPS_BROWSER_ACTION_KINDS = [
  "open",
  "navigate",
  "focus_tab",
  "back",
  "forward",
  "reload",
  "click",
  "type",
  "submit",
  "read_page",
  "extract_links",
  "extract_forms",
] as const;

export type LifeOpsBrowserActionKind =
  (typeof LIFEOPS_BROWSER_ACTION_KINDS)[number];

export interface LifeOpsBrowserAction {
  id: string;
  kind: LifeOpsBrowserActionKind;
  label: string;
  browser?: LifeOpsBrowserKind | null;
  windowId?: string | null;
  tabId?: string | null;
  url: string | null;
  selector: string | null;
  text: string | null;
  accountAffecting: boolean;
  requiresConfirmation: boolean;
  metadata: Record<string, unknown>;
}

export interface LifeOpsWorkflowActionBase {
  id?: string;
  resultKey?: string;
}

export type LifeOpsWorkflowAction =
  | (LifeOpsWorkflowActionBase & {
      kind: "create_task";
      request: CreateLifeOpsDefinitionRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "relock_website_access";
      request: {
        groupKey: string;
      };
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "resolve_website_access_callback";
      request: {
        callbackKey: string;
      };
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "get_calendar_feed";
      request?: GetLifeOpsCalendarFeedRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "get_gmail_triage";
      request?: GetLifeOpsGmailTriageRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "get_gmail_unresponded";
      request?: GetLifeOpsGmailUnrespondedRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "get_health_summary";
      request?: GetLifeOpsHealthSummaryRequest;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "dispatch_workflow";
      workflowId: string;
      payload?: Record<string, unknown>;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "summarize";
      sourceKey?: string;
      prompt?: string;
    })
  | (LifeOpsWorkflowActionBase & {
      kind: "browser";
      sessionTitle: string;
      actions: Array<Omit<LifeOpsBrowserAction, "id">>;
    });

export interface LifeOpsWorkflowActionPlan {
  steps: LifeOpsWorkflowAction[];
}

export const LIFEOPS_OWNER_BROWSER_ACCESS_SOURCES = [
  "lifeops_browser",
  "desktop_browser",
  "discord_desktop",
] as const;

export type LifeOpsOwnerBrowserAccessSource =
  (typeof LIFEOPS_OWNER_BROWSER_ACCESS_SOURCES)[number];

export const LIFEOPS_OWNER_BROWSER_TAB_STATES = [
  "missing",
  "background_discord",
  "discord_open",
  "dm_inbox_visible",
] as const;

export type LifeOpsOwnerBrowserTabState =
  (typeof LIFEOPS_OWNER_BROWSER_TAB_STATES)[number];

export const LIFEOPS_OWNER_BROWSER_AUTH_STATES = [
  "unknown",
  "logged_out",
  "logged_in",
] as const;

export type LifeOpsOwnerBrowserAuthState =
  (typeof LIFEOPS_OWNER_BROWSER_AUTH_STATES)[number];

export const LIFEOPS_OWNER_BROWSER_NEXT_ACTIONS = [
  "none",
  "connect_browser",
  "open_extension_popup",
  "enable_browser_access",
  "enable_browser_control",
  "open_discord",
  "open_dm_inbox",
  "focus_discord_manually",
  "focus_dm_inbox_manually",
  "log_in",
  "open_desktop_browser",
  "relaunch_discord",
] as const;

export type LifeOpsOwnerBrowserNextAction =
  (typeof LIFEOPS_OWNER_BROWSER_NEXT_ACTIONS)[number];

export interface LifeOpsOwnerBrowserAccessStatus {
  source: LifeOpsOwnerBrowserAccessSource;
  active: boolean;
  available: boolean;
  browser: LifeOpsBrowserKind | null;
  profileId: string | null;
  profileLabel: string | null;
  companionId: string | null;
  companionLabel: string | null;
  canControl: boolean;
  siteAccessOk: boolean | null;
  currentUrl: string | null;
  tabState: LifeOpsOwnerBrowserTabState;
  authState: LifeOpsOwnerBrowserAuthState;
  nextAction: LifeOpsOwnerBrowserNextAction;
}

export interface RelockLifeOpsWebsiteAccessRequest {
  groupKey: string;
}

export interface ResolveLifeOpsWebsiteAccessCallbackRequest {
  callbackKey: string;
}

export interface CreateLifeOpsWorkflowRequest {
  ownership?: LifeOpsOwnershipInput;
  title: string;
  triggerType: LifeOpsWorkflowTriggerType;
  schedule?: LifeOpsWorkflowSchedule;
  actionPlan: LifeOpsWorkflowActionPlan;
  permissionPolicy?: Partial<LifeOpsWorkflowPermissionPolicy>;
  status?: LifeOpsWorkflowStatus;
  createdBy?: LifeOpsActor;
  metadata?: Record<string, unknown>;
}

export interface UpdateLifeOpsWorkflowRequest {
  ownership?: LifeOpsOwnershipInput;
  title?: string;
  triggerType?: LifeOpsWorkflowTriggerType;
  schedule?: LifeOpsWorkflowSchedule;
  actionPlan?: LifeOpsWorkflowActionPlan;
  permissionPolicy?: Partial<LifeOpsWorkflowPermissionPolicy>;
  status?: LifeOpsWorkflowStatus;
  metadata?: Record<string, unknown>;
}

export interface RunLifeOpsWorkflowRequest {
  idempotencyKey?: string;
  now?: string;
  confirmBrowserActions?: boolean;
}

export interface LifeOpsWorkflowRecord {
  definition: LifeOpsWorkflowDefinition;
  runs: LifeOpsWorkflowRun[];
}

export const LIFEOPS_BROWSER_SESSION_STATUSES = [
  "awaiting_confirmation",
  "queued",
  "running",
  "done",
  "cancelled",
  "failed",
] as const;

export type LifeOpsBrowserSessionStatus =
  (typeof LIFEOPS_BROWSER_SESSION_STATUSES)[number];

export interface LifeOpsBrowserSession {
  id: string;
  agentId: string;
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
  workflowId: string | null;
  browser: LifeOpsBrowserKind | null;
  companionId: string | null;
  profileId: string | null;
  windowId: string | null;
  tabId: string | null;
  title: string;
  status: LifeOpsBrowserSessionStatus;
  actions: LifeOpsBrowserAction[];
  currentActionIndex: number;
  awaitingConfirmationForActionId: string | null;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CreateLifeOpsBrowserSessionRequest {
  ownership?: LifeOpsOwnershipInput;
  workflowId?: string | null;
  browser?: LifeOpsBrowserKind | null;
  companionId?: string | null;
  profileId?: string | null;
  windowId?: string | null;
  tabId?: string | null;
  title: string;
  actions: Array<Omit<LifeOpsBrowserAction, "id">>;
}

export interface ConfirmLifeOpsBrowserSessionRequest {
  confirmed: boolean;
}

export interface UpdateLifeOpsBrowserSessionProgressRequest {
  currentActionIndex?: number;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CompleteLifeOpsBrowserSessionRequest {
  status?: Extract<LifeOpsBrowserSessionStatus, "done" | "failed">;
  result?: Record<string, unknown>;
  currentActionIndex?: number;
  completedActionId?: string | null;
  attemptId?: string | null;
}

// ── Settings card prop contracts ─────────────────────────────────────────────

export type AppBlockerSettingsMode = "desktop" | "mobile" | "web";

export interface AppBlockerSettingsCardProps {
  mode: AppBlockerSettingsMode;
}

export type WebsiteBlockerSettingsMode = "desktop" | "mobile" | "web";

export interface WebsiteBlockerSettingsCardProps {
  mode: WebsiteBlockerSettingsMode;
  permission?: import("@elizaos/core/protocol").PermissionState;
  platform?: string;
  onOpenPermissionSettings?: () => void | Promise<void>;
  onRequestPermission?: () => void | Promise<void>;
}

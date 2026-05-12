import crypto from "node:crypto";
import type {
  BrowserBridgeAction,
  BrowserBridgeCompanionStatus,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
} from "@elizaos/plugin-browser";
import type {
  LifeOpsBrowserSession,
  LifeOpsCalendarEvent,
  LifeOpsOccurrenceView,
  LifeOpsWorkflowRun,
} from "../contracts/index.js";
import type { LifeOpsWebsiteAccessGrant } from "./repository.js";
import {
  fail,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import type { LifeOpsWorkflowSchedulerState } from "./service-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value };
}

export function collectNearbyReminderTitles(args: {
  currentOwnerId: string;
  currentAnchorAt: string | null;
  occurrences: Array<Pick<LifeOpsOccurrenceView, "id" | "title" | "dueAt">>;
  events: Array<Pick<LifeOpsCalendarEvent, "id" | "title" | "startAt">>;
  limit?: number;
}): string[] {
  const anchorMs = Date.parse(args.currentAnchorAt ?? "");
  const candidates = [
    ...args.occurrences
      .filter((occurrence) => occurrence.id !== args.currentOwnerId)
      .map((occurrence) => ({
        title: occurrence.title,
        at: occurrence.dueAt,
      })),
    ...args.events
      .filter((event) => event.id !== args.currentOwnerId)
      .map((event) => ({
        title: event.title,
        at: event.startAt,
      })),
  ]
    .filter(
      (
        candidate,
      ): candidate is {
        title: string;
        at: string;
      } =>
        typeof candidate.title === "string" &&
        candidate.title.trim().length > 0 &&
        typeof candidate.at === "string" &&
        candidate.at.trim().length > 0,
    )
    .map((candidate) => ({
      title: candidate.title.trim(),
      atMs: Date.parse(candidate.at.trim()),
    }))
    .filter((candidate) => Number.isFinite(candidate.atMs))
    .sort((left, right) => {
      if (Number.isFinite(anchorMs)) {
        return Math.abs(left.atMs - anchorMs) - Math.abs(right.atMs - anchorMs);
      }
      return left.atMs - right.atMs;
    });

  return [...new Set(candidates.map((candidate) => candidate.title))].slice(
    0,
    Math.max(0, args.limit ?? 3),
  );
}

export function createBrowserSessionActions(
  actions: Array<Omit<BrowserBridgeAction, "id">>,
): BrowserBridgeAction[] {
  return actions.map((action) => ({
    ...action,
    id: crypto.randomUUID(),
  }));
}

export function hashBrowserCompanionPairingToken(token: string): string {
  return crypto
    .createHash("sha256")
    .update(requireNonEmptyString(token, "pairingToken"))
    .digest("hex");
}

export const MAX_PENDING_BROWSER_PAIRING_TOKENS = 4;

export function normalizePendingBrowserPairingTokenHashes(
  hashes: readonly string[],
  activePairingTokenHash: string | null,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of hashes) {
    if (
      !candidate ||
      candidate === activePairingTokenHash ||
      seen.has(candidate)
    ) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
    if (normalized.length >= MAX_PENDING_BROWSER_PAIRING_TOKENS) {
      break;
    }
  }
  return normalized;
}

export function browserSessionMatchesCompanion(
  session: LifeOpsBrowserSession,
  companion: BrowserBridgeCompanionStatus,
): boolean {
  if (session.browser && session.browser !== companion.browser) {
    return false;
  }
  if (session.companionId && session.companionId !== companion.id) {
    return false;
  }
  if (session.profileId && session.profileId !== companion.profileId) {
    return false;
  }
  return true;
}

export function normalizeBrowserSessionActionIndex(
  value: unknown,
  maxActions: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(400, "currentActionIndex must be a non-negative integer");
  }
  if (maxActions <= 0) {
    return 0;
  }
  return Math.min(value, maxActions - 1);
}

export function resolveAwaitingBrowserActionId(
  actions: BrowserBridgeAction[],
): string | null {
  const next = actions.find(
    (action) => action.accountAffecting || action.requiresConfirmation,
  );
  return next?.id ?? null;
}

export function browserActionChangesState(
  action: Pick<BrowserBridgeAction, "kind">,
): boolean {
  return (
    action.kind === "open" ||
    action.kind === "navigate" ||
    action.kind === "focus_tab" ||
    action.kind === "back" ||
    action.kind === "forward" ||
    action.kind === "reload" ||
    action.kind === "click" ||
    action.kind === "type" ||
    action.kind === "submit"
  );
}

export function browserTabIdentityKey(
  tab: Pick<
    BrowserBridgeTabSummary,
    "browser" | "profileId" | "windowId" | "tabId"
  >,
): string {
  return `${tab.browser}:${tab.profileId}:${tab.windowId}:${tab.tabId}`;
}

export function browserPageContextIdentityKey(
  context: Pick<
    BrowserBridgePageContext,
    "browser" | "profileId" | "windowId" | "tabId"
  >,
): string {
  return `${context.browser}:${context.profileId}:${context.windowId}:${context.tabId}`;
}

export function rankBrowserTab(tab: BrowserBridgeTabSummary): [number, number] {
  const anchor = Date.parse(tab.lastFocusedAt ?? tab.lastSeenAt);
  return [
    tab.focusedActive ? 3 : tab.activeInWindow ? 2 : 1,
    Number.isFinite(anchor) ? anchor : 0,
  ];
}

export function sortBrowserTabs(
  tabs: readonly BrowserBridgeTabSummary[],
): BrowserBridgeTabSummary[] {
  return [...tabs].sort((left, right) => {
    const [leftTier, leftAnchor] = rankBrowserTab(left);
    const [rightTier, rightAnchor] = rankBrowserTab(right);
    if (leftTier !== rightTier) {
      return rightTier - leftTier;
    }
    if (leftAnchor !== rightAnchor) {
      return rightAnchor - leftAnchor;
    }
    return left.title.localeCompare(right.title);
  });
}

export function selectRememberedBrowserTabs(
  tabs: readonly BrowserBridgeTabSummary[],
  limit: number,
): BrowserBridgeTabSummary[] {
  if (limit <= 0 || tabs.length === 0) {
    return [];
  }
  const sorted = sortBrowserTabs(tabs);
  const active = sorted.filter((tab) => tab.activeInWindow);
  if (active.length >= limit) {
    return active.slice(0, limit);
  }
  const seen = new Set(active.map((tab) => tab.id));
  const extras = sorted.filter((tab) => !seen.has(tab.id));
  return [...active, ...extras.slice(0, Math.max(0, limit - active.length))];
}

export function redactSecretLikeText(value: unknown): string | null {
  const text = normalizeOptionalString(value);
  if (!text) {
    return null;
  }
  const secretPattern =
    /\b(?:sk|pk|rk|ghp|gho|ghu|xoxb|xoxp)_[A-Za-z0-9_-]{8,}\b/g;
  return text.replace(secretPattern, "[redacted-secret]");
}

export function browserOriginFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

export function browserUrlAllowedBySettings(
  url: string,
  settings: BrowserBridgeSettings,
): boolean {
  const origin = browserOriginFromUrl(url);
  if (!origin) {
    return false;
  }
  if (settings.blockedOrigins.includes(origin)) {
    return false;
  }
  if (settings.siteAccessMode === "granted_sites") {
    return settings.grantedOrigins.includes(origin);
  }
  return true;
}

export function normalizePageLinks(
  value: unknown,
  field: string,
): BrowserBridgePageContext["links"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value.map((candidate, index) => {
    const record = requireRecord(candidate, `${field}[${index}]`);
    return {
      text: requireNonEmptyString(record.text, `${field}[${index}].text`),
      href: requireNonEmptyString(record.href, `${field}[${index}].href`),
    };
  });
}

export function normalizePageHeadings(
  value: unknown,
  field: string,
): BrowserBridgePageContext["headings"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value.map((candidate, index) =>
    requireNonEmptyString(candidate, `${field}[${index}]`),
  );
}

export function normalizePageForms(
  value: unknown,
  field: string,
): BrowserBridgePageContext["forms"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value.map((candidate, index) => {
    const record = requireRecord(candidate, `${field}[${index}]`);
    if (!Array.isArray(record.fields)) {
      fail(400, `${field}[${index}].fields must be an array`);
    }
    return {
      action:
        record.action === undefined || record.action === null
          ? null
          : requireNonEmptyString(record.action, `${field}[${index}].action`),
      fields: record.fields.map((entry, fieldIndex) =>
        requireNonEmptyString(
          entry,
          `${field}[${index}].fields[${fieldIndex}]`,
        ),
      ),
    };
  });
}

export function describeWorkflowValue(value: unknown, label?: string): string {
  const prefix = label?.trim() ? `${label.trim()}: ` : "";
  if (isRecord(value) && Array.isArray(value.events)) {
    const titles = value.events
      .map((event) =>
        isRecord(event) && typeof event.title === "string" ? event.title : "",
      )
      .filter((title) => title.length > 0)
      .slice(0, 3);
    return `${prefix}${titles.length} calendar events${titles.length > 0 ? ` (${titles.join(", ")})` : ""}`;
  }
  if (isRecord(value) && Array.isArray(value.messages)) {
    const subjects = value.messages
      .map((message) =>
        isRecord(message) && typeof message.subject === "string"
          ? message.subject
          : "",
      )
      .filter((subject) => subject.length > 0)
      .slice(0, 3);
    return `${prefix}${subjects.length} Gmail items${subjects.length > 0 ? ` (${subjects.join(", ")})` : ""}`;
  }
  if (typeof value === "string") {
    return `${prefix}${value}`;
  }
  return `${prefix}${JSON.stringify(value)}`;
}

export function parseWorkflowSchedulerState(
  value: unknown,
): LifeOpsWorkflowSchedulerState | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    managedBy: "task_worker",
    nextDueAt:
      typeof value.nextDueAt === "string" && value.nextDueAt.trim().length > 0
        ? value.nextDueAt
        : null,
    lastDueAt:
      typeof value.lastDueAt === "string" && value.lastDueAt.trim().length > 0
        ? value.lastDueAt
        : null,
    lastRunId:
      typeof value.lastRunId === "string" && value.lastRunId.trim().length > 0
        ? value.lastRunId
        : null,
    lastRunStatus:
      typeof value.lastRunStatus === "string" && value.lastRunStatus.length > 0
        ? (value.lastRunStatus as LifeOpsWorkflowRun["status"])
        : null,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0
        ? value.updatedAt
        : new Date().toISOString(),
    lastFiredEventEndAt:
      typeof value.lastFiredEventEndAt === "string" &&
      value.lastFiredEventEndAt.trim().length > 0
        ? value.lastFiredEventEndAt
        : null,
    lastFiredEventId:
      typeof value.lastFiredEventId === "string" &&
      value.lastFiredEventId.trim().length > 0
        ? value.lastFiredEventId
        : null,
  };
}

export const LIFEOPS_OWNER_CONTACTS_LOAD_CONTEXT = {
  boundary: "lifeops",
  operation: "owner_contacts_config",
  message:
    "[lifeops] Failed to load owner contacts config; runtime reminder channels will fall back to channel-policy metadata only.",
} as const;

export function normalizeWebsiteListForComparison(
  websites: readonly string[],
): string[] {
  return [...new Set(websites.map((website) => website.toLowerCase().trim()))]
    .filter((website) => website.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export function haveSameWebsiteSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = normalizeWebsiteListForComparison(left);
  const normalizedRight = normalizeWebsiteListForComparison(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((website, index) => website === normalizedRight[index])
  );
}

export function isWebsiteAccessGrantActive(
  grant: LifeOpsWebsiteAccessGrant,
  now: Date,
): boolean {
  if (grant.revokedAt) {
    return false;
  }
  return !grant.expiresAt || Date.parse(grant.expiresAt) > now.getTime();
}

// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import type {
  CreateLifeOpsBrowserCompanionAutoPairRequest,
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  LifeOpsBrowserCompanionAutoPairResponse,
  LifeOpsBrowserCompanionConfig,
  CreateLifeOpsBrowserCompanionPairingRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserCompanionPairingResponse,
  LifeOpsBrowserCompanionStatus,
  LifeOpsBrowserCompanionSyncResponse,
  LifeOpsBrowserPageContext,
  LifeOpsBrowserSession,
  LifeOpsBrowserSettings,
  LifeOpsBrowserTabSummary,
  SyncLifeOpsBrowserStateRequest,
  UpdateLifeOpsBrowserSessionProgressRequest,
  UpdateLifeOpsBrowserSettingsRequest,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_BROWSER_KINDS,
} from "@elizaos/shared/contracts/lifeops";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import { recordBrowserFocusWindow } from "./browser-extension-store.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

// ---------------------------------------------------------------------------
// Local helpers (copied from service.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeMetadata(
  current: Record<string, unknown>,
  updates?: Record<string, unknown>,
): Record<string, unknown> {
  const cloned =
    updates && typeof updates === "object" && !Array.isArray(updates)
      ? { ...updates }
      : {};
  return { ...current, ...cloned };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

function normalizeOptionalBoolean(
  value: unknown,
  field: string,
): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  fail(400, `${field} must be a boolean`);
}

function normalizeOptionalIsoString(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, `${field} must be an ISO 8601 string`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    fail(400, `${field} must be a valid ISO 8601 string`);
  }
  return value;
}

function normalizeOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

// Browser-specific helpers

function hashBrowserCompanionPairingToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizePendingBrowserPairingTokenHashes(
  pending: string[],
  currentHash: string,
): string[] {
  const MAX_PENDING = 3;
  return pending
    .filter((hash) => hash !== currentHash)
    .slice(0, MAX_PENDING);
}

function browserSessionMatchesCompanion(
  session: LifeOpsBrowserSession,
  companion: LifeOpsBrowserCompanionStatus,
): boolean {
  if (session.companionId && session.companionId !== companion.id) {
    return false;
  }
  if (session.browser && session.browser !== companion.browser) {
    return false;
  }
  if (session.profileId && session.profileId !== companion.profileId) {
    return false;
  }
  return true;
}

function normalizeBrowserSessionActionIndex(
  value: unknown,
  actionsLength: number,
): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isInteger(num) || num < 0) {
    fail(400, "currentActionIndex must be a non-negative integer");
  }
  return Math.min(num, Math.max(0, actionsLength - 1));
}

function browserTabIdentityKey(
  tab: Pick<LifeOpsBrowserTabSummary, "browser" | "profileId" | "windowId" | "tabId">,
): string {
  return `${tab.browser}:${tab.profileId}:${tab.windowId}:${tab.tabId}`;
}

function browserPageContextIdentityKey(
  context: Pick<LifeOpsBrowserPageContext, "browser" | "profileId" | "windowId" | "tabId">,
): string {
  return `${context.browser}:${context.profileId}:${context.windowId}:${context.tabId}`;
}

function selectRememberedBrowserTabs(
  tabs: LifeOpsBrowserTabSummary[],
  maxRememberedTabs: number,
): LifeOpsBrowserTabSummary[] {
  if (tabs.length <= maxRememberedTabs) return tabs;
  const sorted = tabs.slice().sort((left, right) => {
    if (left.focusedActive && !right.focusedActive) return -1;
    if (!left.focusedActive && right.focusedActive) return 1;
    if (left.activeInWindow && !right.activeInWindow) return -1;
    if (!left.activeInWindow && right.activeInWindow) return 1;
    const leftFocusMs = left.lastFocusedAt ? Date.parse(left.lastFocusedAt) : 0;
    const rightFocusMs = right.lastFocusedAt ? Date.parse(right.lastFocusedAt) : 0;
    return rightFocusMs - leftFocusMs;
  });
  return sorted.slice(0, maxRememberedTabs);
}

const MAX_BROWSER_FOCUS_WINDOW_MS = 2 * 60 * 1000;

function browserUrlAllowedBySettings(
  url: string,
  settings: LifeOpsBrowserSettings,
): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const origin = parsed.origin.toLowerCase();
    if (settings.blockedOrigins.some((blocked) => origin.includes(blocked.toLowerCase()))) {
      return false;
    }
    if (settings.siteAccessMode === "granted_sites_only" && settings.grantedOrigins.length > 0) {
      return settings.grantedOrigins.some((granted) => origin.includes(granted.toLowerCase()));
    }
    return true;
  } catch {
    return false;
  }
}

function browserDomainFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const hostname = parsed.hostname.trim().toLowerCase().replace(/\.+$/, "");
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

function redactSecretLikeText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  return value;
}

function normalizePageLinks(
  value: unknown,
  field: string,
): Array<{ text: string; href: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value as Array<{ text: string; href: string }>;
}

function normalizePageHeadings(
  value: unknown,
  field: string,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value as string[];
}

function normalizePageForms(
  value: unknown,
  field: string,
): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return value as Array<Record<string, unknown>>;
}

function normalizeBrowserSettingsUpdate(
  request: UpdateLifeOpsBrowserSettingsRequest,
  current: LifeOpsBrowserSettings,
): LifeOpsBrowserSettings {
  return {
    ...current,
    enabled: normalizeOptionalBoolean(request.enabled, "enabled") ?? current.enabled,
    trackingMode: request.trackingMode ?? current.trackingMode,
    allowBrowserControl: normalizeOptionalBoolean(request.allowBrowserControl, "allowBrowserControl") ?? current.allowBrowserControl,
    requireConfirmationForAccountAffecting: normalizeOptionalBoolean(request.requireConfirmationForAccountAffecting, "requireConfirmationForAccountAffecting") ?? current.requireConfirmationForAccountAffecting,
    incognitoEnabled: normalizeOptionalBoolean(request.incognitoEnabled, "incognitoEnabled") ?? current.incognitoEnabled,
    siteAccessMode: request.siteAccessMode ?? current.siteAccessMode,
    grantedOrigins: request.grantedOrigins ?? [...current.grantedOrigins],
    blockedOrigins: request.blockedOrigins ?? [...current.blockedOrigins],
    maxRememberedTabs: request.maxRememberedTabs ?? current.maxRememberedTabs,
    pauseUntil: request.pauseUntil !== undefined ? (request.pauseUntil ?? null) : current.pauseUntil,
    metadata: request.metadata !== undefined ? mergeMetadata(current.metadata, request.metadata as Record<string, unknown>) : current.metadata,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeOptionalBrowserKind(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeEnumValue(value, field, LIFEOPS_BROWSER_KINDS);
}

function normalizeBrowserActionInput(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

function createBrowserSessionActions(
  actions: Record<string, unknown>[],
): any[] {
  return actions.map((action, index) => ({
    id: crypto.randomUUID(),
    ...action,
  }));
}

function resolveAwaitingBrowserActionId(
  actions: readonly any[],
): string | null {
  for (const action of actions) {
    if (action.requireConfirmation === true) {
      return action.id ?? null;
    }
  }
  return null;
}

// Imports from repository
import {
  createLifeOpsBrowserPageContext,
  createLifeOpsBrowserSession,
  createLifeOpsBrowserTabSummary,
} from "./repository.js";
import {
  DEFAULT_BROWSER_PERMISSION_STATE,
} from "./service-constants.js";

// ---------------------------------------------------------------------------
// Browser mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withBrowser<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsBrowserServiceMixin extends Base {
    public async createBrowserSessionInternal(
      request: CreateLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      const workflowId = normalizeOptionalString(request.workflowId) ?? null;
      const workflow = workflowId
        ? await this.getWorkflowDefinition(workflowId)
        : null;
      const ownership = workflow
        ? this.normalizeChildOwnership(workflow, request.ownership)
        : this.normalizeOwnership(request.ownership);
      const actions = createBrowserSessionActions(
        request.actions.map((action, index) =>
          normalizeBrowserActionInput(action, `actions[${index}]`),
        ),
      );
      await this.requireBrowserAvailableForActions(actions);
      const awaitingActionId = resolveAwaitingBrowserActionId(actions);
      const session = createLifeOpsBrowserSession({
        agentId: this.agentId(),
        ...ownership,
        workflowId,
        browser: normalizeOptionalBrowserKind(request.browser, "browser"),
        companionId: normalizeOptionalString(request.companionId) ?? null,
        profileId: normalizeOptionalString(request.profileId) ?? null,
        windowId: normalizeOptionalString(request.windowId) ?? null,
        tabId: normalizeOptionalString(request.tabId) ?? null,
        title: requireNonEmptyString(request.title, "title"),
        status: awaitingActionId ? "awaiting_confirmation" : "queued",
        actions,
        currentActionIndex: 0,
        awaitingConfirmationForActionId: awaitingActionId,
        result: {},
        metadata: {},
        finishedAt: null,
      });
      await this.repository.createBrowserSession(session);
      await this.recordBrowserAudit(
        "browser_session_created",
        session.id,
        "browser session created",
        {
          workflowId: session.workflowId,
          title: session.title,
          browser: session.browser,
          profileId: session.profileId,
          windowId: session.windowId,
          tabId: session.tabId,
        },
        {
          status: session.status,
          actionCount: session.actions.length,
        },
      );
      return session;
    }

    public async requireBrowserCompanion(
      companionId: string,
      pairingToken: string,
    ): Promise<LifeOpsBrowserCompanionStatus> {
      const credential = await this.repository.getBrowserCompanionCredential(
        this.agentId(),
        requireNonEmptyString(companionId, "companionId"),
      );
      if (!credential?.pairingTokenHash) {
        if (!credential) {
          fail(401, "browser companion pairing is invalid");
        }
        const pendingPairingTokenHashes =
          credential.pendingPairingTokenHashes ?? [];
        const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
        if (!pendingPairingTokenHashes.includes(pairingTokenHash)) {
          fail(401, "browser companion pairing is invalid");
        }
        const nowIso = new Date().toISOString();
        const remainingPendingPairingTokenHashes =
          normalizePendingBrowserPairingTokenHashes(
            pendingPairingTokenHashes.filter(
              (candidate) => candidate !== pairingTokenHash,
            ),
            pairingTokenHash,
          );
        await this.repository.promoteBrowserCompanionPendingPairingToken(
          this.agentId(),
          credential.companion.id,
          pairingTokenHash,
          remainingPendingPairingTokenHashes,
          nowIso,
          nowIso,
        );
        return {
          ...credential.companion,
          pairedAt: nowIso,
          updatedAt: nowIso,
        };
      }
      const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
      if (credential.pairingTokenHash === pairingTokenHash) {
        return credential.companion;
      }
      const pendingPairingTokenHashes =
        credential.pendingPairingTokenHashes ?? [];
      if (!pendingPairingTokenHashes.includes(pairingTokenHash)) {
        fail(401, "browser companion pairing is invalid");
      }
      const nowIso = new Date().toISOString();
      const remainingPendingPairingTokenHashes =
        normalizePendingBrowserPairingTokenHashes(
          pendingPairingTokenHashes.filter(
            (candidate) => candidate !== pairingTokenHash,
          ),
          pairingTokenHash,
        );
      await this.repository.promoteBrowserCompanionPendingPairingToken(
        this.agentId(),
        credential.companion.id,
        pairingTokenHash,
        remainingPendingPairingTokenHashes,
        nowIso,
        nowIso,
      );
      return {
        ...credential.companion,
        pairedAt: nowIso,
        updatedAt: nowIso,
      };
    }

    public async claimQueuedBrowserSession(
      companion: LifeOpsBrowserCompanionStatus,
    ): Promise<LifeOpsBrowserSession | null> {
      const claimable = (await this.listBrowserSessions())
        .filter(
          (session) =>
            session.status === "queued" &&
            browserSessionMatchesCompanion(session, companion),
        )
        .sort((left, right) => {
          const leftMs = Date.parse(left.createdAt);
          const rightMs = Date.parse(right.createdAt);
          if (
            Number.isFinite(leftMs) &&
            Number.isFinite(rightMs) &&
            leftMs !== rightMs
          ) {
            return leftMs - rightMs;
          }
          return left.createdAt.localeCompare(right.createdAt);
        })[0];
      if (!claimable) {
        return null;
      }
      const nowIso = new Date().toISOString();
      const nextSession: LifeOpsBrowserSession = {
        ...claimable,
        status: "running",
        metadata: mergeMetadata(claimable.metadata, {
          claimedAt: nowIso,
          claimedByCompanionId: companion.id,
        }),
        updatedAt: nowIso,
      };
      await this.repository.updateBrowserSession(nextSession);
      await this.recordBrowserAudit(
        "browser_session_updated",
        nextSession.id,
        "browser session claimed by companion",
        {
          companionId: companion.id,
          browser: companion.browser,
          profileId: companion.profileId,
        },
        {
          status: nextSession.status,
        },
      );
      return nextSession;
    }

    public async requireBrowserSessionForCompanion(
      companion: LifeOpsBrowserCompanionStatus,
      sessionId: string,
    ): Promise<LifeOpsBrowserSession> {
      const session = await this.getBrowserSession(sessionId);
      if (!browserSessionMatchesCompanion(session, companion)) {
        fail(403, "browser session does not belong to this browser companion");
      }
      return session;
    }

    async getBrowserSettings(): Promise<LifeOpsBrowserSettings> {
      return this.getBrowserSettingsInternal();
    }

    async updateBrowserSettings(
      request: UpdateLifeOpsBrowserSettingsRequest,
    ): Promise<LifeOpsBrowserSettings> {
      const current = await this.getBrowserSettingsInternal();
      const next = normalizeBrowserSettingsUpdate(request, current);
      await this.repository.upsertBrowserSettings(this.agentId(), next);
      if (
        !next.enabled ||
        next.trackingMode === "off" ||
        this.isBrowserPaused(next)
      ) {
        await this.repository.deleteAllBrowserTabs(this.agentId());
        await this.repository.deleteAllBrowserPageContexts(this.agentId());
      }
      return this.getBrowserSettingsInternal();
    }

    async listBrowserCompanions(): Promise<LifeOpsBrowserCompanionStatus[]> {
      return this.repository.listBrowserCompanions(this.agentId());
    }

    async listBrowserTabs(): Promise<LifeOpsBrowserTabSummary[]> {
      const settings = await this.getBrowserSettingsInternal();
      if (
        !settings.enabled ||
        settings.trackingMode === "off" ||
        this.isBrowserPaused(settings)
      ) {
        return [];
      }
      const tabs = await this.repository.listBrowserTabs(this.agentId());
      return selectRememberedBrowserTabs(
        tabs.filter((tab) => browserUrlAllowedBySettings(tab.url, settings)),
        settings.maxRememberedTabs,
      );
    }

    async getCurrentBrowserPage(): Promise<LifeOpsBrowserPageContext | null> {
      const settings = await this.getBrowserSettingsInternal();
      if (
        !settings.enabled ||
        settings.trackingMode === "off" ||
        this.isBrowserPaused(settings)
      ) {
        return null;
      }
      const tabs = await this.listBrowserTabs();
      const focusedTab =
        tabs.find((tab) => tab.focusedActive) ??
        tabs.find((tab) => tab.activeInWindow) ??
        tabs[0] ??
        null;
      if (!focusedTab) {
        return null;
      }
      const contexts = await this.repository.listBrowserPageContexts(
        this.agentId(),
      );
      return (
        contexts.find(
          (context) =>
            browserPageContextIdentityKey(context) ===
              browserTabIdentityKey(focusedTab) &&
            browserUrlAllowedBySettings(context.url, settings),
        ) ?? null
      );
    }

    async syncBrowserState(request: SyncLifeOpsBrowserStateRequest): Promise<{
      companion: LifeOpsBrowserCompanionStatus;
      tabs: LifeOpsBrowserTabSummary[];
      currentPage: LifeOpsBrowserPageContext | null;
    }> {
      const companionInput = requireRecord(request.companion, "companion");
      const browser = normalizeEnumValue(
        companionInput.browser,
        "companion.browser",
        LIFEOPS_BROWSER_KINDS,
      );
      const profileId = requireNonEmptyString(
        companionInput.profileId,
        "companion.profileId",
      );
      const currentCompanion = await this.repository.getBrowserCompanionByProfile(
        this.agentId(),
        browser,
        profileId,
      );
      const companion = this.buildBrowserCompanion(
        request.companion,
        currentCompanion,
      );
      await this.repository.upsertBrowserCompanion(companion);

      const settings = await this.getBrowserSettingsInternal();
      if (
        !settings.enabled ||
        settings.trackingMode === "off" ||
        this.isBrowserPaused(settings)
      ) {
        await this.repository.deleteAllBrowserTabs(this.agentId());
        await this.repository.deleteAllBrowserPageContexts(this.agentId());
        return {
          companion,
          tabs: [],
          currentPage: null,
        };
      }

      const nowIso =
        normalizeOptionalIsoString(
          companionInput.lastSeenAt,
          "companion.lastSeenAt",
        ) ?? new Date().toISOString();
      const existingTabs = await this.repository.listBrowserTabs(this.agentId());
      const currentSyncMs = Date.parse(nowIso);
      const previouslyFocusedTab =
        existingTabs.find((tab) => tab.focusedActive) ?? null;
      if (previouslyFocusedTab && Number.isFinite(currentSyncMs)) {
        const previousSeenMs = Date.parse(previouslyFocusedTab.lastSeenAt);
        if (Number.isFinite(previousSeenMs) && currentSyncMs > previousSeenMs) {
          const cappedStartMs = Math.max(
            previousSeenMs,
            currentSyncMs - MAX_BROWSER_FOCUS_WINDOW_MS,
          );
          await recordBrowserFocusWindow(this.runtime, {
            deviceId: companion.id,
            url: previouslyFocusedTab.url,
            windowStart: new Date(cappedStartMs).toISOString(),
            windowEnd: nowIso,
          });
          const domain = browserDomainFromUrl(previouslyFocusedTab.url);
          if (domain) {
            await this.recordScreenTimeEvent({
              source: "website",
              identifier: domain,
              displayName: domain,
              startAt: new Date(cappedStartMs).toISOString(),
              endAt: nowIso,
              metadata: {
                url: previouslyFocusedTab.url,
                browser: previouslyFocusedTab.browser,
                profileId: previouslyFocusedTab.profileId,
                companionId: companion.id,
              },
            });
          }
        }
      }
      const existingTabsByKey = new Map(
        existingTabs.map((tab) => [browserTabIdentityKey(tab), tab]),
      );
      for (const [index, candidate] of request.tabs.entries()) {
        const tabRecord = requireRecord(candidate, `tabs[${index}]`);
        const tabBrowser = normalizeEnumValue(
          tabRecord.browser,
          `tabs[${index}].browser`,
          LIFEOPS_BROWSER_KINDS,
        );
        const tabProfileId = requireNonEmptyString(
          tabRecord.profileId,
          `tabs[${index}].profileId`,
        );
        if (tabBrowser !== browser || tabProfileId !== profileId) {
          fail(
            400,
            `tabs[${index}] must match companion.browser and companion.profileId`,
          );
        }
        const url = requireNonEmptyString(tabRecord.url, `tabs[${index}].url`);
        const existing =
          existingTabsByKey.get(
            `${tabBrowser}:${tabProfileId}:${requireNonEmptyString(tabRecord.windowId, `tabs[${index}].windowId`)}:${requireNonEmptyString(tabRecord.tabId, `tabs[${index}].tabId`)}`,
          ) ?? null;
        const lastSeenAt =
          normalizeOptionalIsoString(
            tabRecord.lastSeenAt,
            `tabs[${index}].lastSeenAt`,
          ) ?? nowIso;
        const focusedActive =
          normalizeOptionalBoolean(
            tabRecord.focusedActive,
            `tabs[${index}].focusedActive`,
          ) ?? false;
        const activeInWindow =
          normalizeOptionalBoolean(
            tabRecord.activeInWindow,
            `tabs[${index}].activeInWindow`,
          ) ?? focusedActive;
        const lastFocusedAt =
          normalizeOptionalIsoString(
            tabRecord.lastFocusedAt,
            `tabs[${index}].lastFocusedAt`,
          ) ??
          (focusedActive || activeInWindow
            ? lastSeenAt
            : (existing?.lastFocusedAt ?? null));
        const nextTab = existing
          ? {
              ...existing,
              companionId: companion.id,
              url,
              title: requireNonEmptyString(
                tabRecord.title,
                `tabs[${index}].title`,
              ),
              activeInWindow,
              focusedWindow:
                normalizeOptionalBoolean(
                  tabRecord.focusedWindow,
                  `tabs[${index}].focusedWindow`,
                ) ?? focusedActive,
              focusedActive,
              incognito:
                normalizeOptionalBoolean(
                  tabRecord.incognito,
                  `tabs[${index}].incognito`,
                ) ?? false,
              faviconUrl: normalizeOptionalString(tabRecord.faviconUrl) ?? null,
              lastSeenAt,
              lastFocusedAt,
              metadata: mergeMetadata(
                existing.metadata,
                normalizeOptionalRecord(
                  tabRecord.metadata,
                  `tabs[${index}].metadata`,
                ),
              ),
              updatedAt: nowIso,
            }
          : createLifeOpsBrowserTabSummary({
              agentId: this.agentId(),
              companionId: companion.id,
              browser: tabBrowser,
              profileId: tabProfileId,
              windowId: requireNonEmptyString(
                tabRecord.windowId,
                `tabs[${index}].windowId`,
              ),
              tabId: requireNonEmptyString(
                tabRecord.tabId,
                `tabs[${index}].tabId`,
              ),
              url,
              title: requireNonEmptyString(
                tabRecord.title,
                `tabs[${index}].title`,
              ),
              activeInWindow,
              focusedWindow:
                normalizeOptionalBoolean(
                  tabRecord.focusedWindow,
                  `tabs[${index}].focusedWindow`,
                ) ?? focusedActive,
              focusedActive,
              incognito:
                normalizeOptionalBoolean(
                  tabRecord.incognito,
                  `tabs[${index}].incognito`,
                ) ?? false,
              faviconUrl: normalizeOptionalString(tabRecord.faviconUrl) ?? null,
              lastSeenAt,
              lastFocusedAt,
              metadata:
                normalizeOptionalRecord(
                  tabRecord.metadata,
                  `tabs[${index}].metadata`,
                ) ?? {},
            });
        if (!browserUrlAllowedBySettings(nextTab.url, settings)) {
          continue;
        }
        await this.repository.upsertBrowserTab(nextTab);
      }

      const allTabs = await this.repository.listBrowserTabs(this.agentId());
      const keptTabs = selectRememberedBrowserTabs(
        allTabs.filter((tab) => browserUrlAllowedBySettings(tab.url, settings)),
        settings.maxRememberedTabs,
      );
      const keptTabIds = new Set(keptTabs.map((tab) => tab.id));
      await this.repository.deleteBrowserTabsByIds(
        this.agentId(),
        allTabs.filter((tab) => !keptTabIds.has(tab.id)).map((tab) => tab.id),
      );

      const focusedTab =
        keptTabs.find((tab) => tab.focusedActive) ??
        keptTabs.find((tab) => tab.activeInWindow) ??
        keptTabs[0] ??
        null;
      const focusedKey = focusedTab ? browserTabIdentityKey(focusedTab) : null;
      const existingContexts = await this.repository.listBrowserPageContexts(
        this.agentId(),
      );
      const existingContextsByKey = new Map(
        existingContexts.map((context) => [
          browserPageContextIdentityKey(context),
          context,
        ]),
      );
      const syncedContextIds = new Set<string>();
      for (const [index, candidate] of (request.pageContexts ?? []).entries()) {
        const contextRecord = requireRecord(candidate, `pageContexts[${index}]`);
        const contextBrowser = normalizeEnumValue(
          contextRecord.browser,
          `pageContexts[${index}].browser`,
          LIFEOPS_BROWSER_KINDS,
        );
        const contextProfileId = requireNonEmptyString(
          contextRecord.profileId,
          `pageContexts[${index}].profileId`,
        );
        const windowId = requireNonEmptyString(
          contextRecord.windowId,
          `pageContexts[${index}].windowId`,
        );
        const tabId = requireNonEmptyString(
          contextRecord.tabId,
          `pageContexts[${index}].tabId`,
        );
        if (contextBrowser !== browser || contextProfileId !== profileId) {
          fail(
            400,
            `pageContexts[${index}] must match companion.browser and companion.profileId`,
          );
        }
        const key = `${contextBrowser}:${contextProfileId}:${windowId}:${tabId}`;
        if (!focusedKey || key !== focusedKey) {
          continue;
        }
        const url = requireNonEmptyString(
          contextRecord.url,
          `pageContexts[${index}].url`,
        );
        if (!browserUrlAllowedBySettings(url, settings)) {
          continue;
        }
        const existing = existingContextsByKey.get(key) ?? null;
        const nextContext = existing
          ? {
              ...existing,
              url,
              title: requireNonEmptyString(
                contextRecord.title,
                `pageContexts[${index}].title`,
              ),
              selectionText: redactSecretLikeText(contextRecord.selectionText),
              mainText: redactSecretLikeText(contextRecord.mainText),
              headings:
                contextRecord.headings === undefined
                  ? existing.headings
                  : normalizePageHeadings(
                      contextRecord.headings,
                      `pageContexts[${index}].headings`,
                    ),
              links: normalizePageLinks(
                contextRecord.links,
                `pageContexts[${index}].links`,
              ),
              forms: normalizePageForms(
                contextRecord.forms,
                `pageContexts[${index}].forms`,
              ),
              capturedAt:
                normalizeOptionalIsoString(
                  contextRecord.capturedAt,
                  `pageContexts[${index}].capturedAt`,
                ) ?? nowIso,
              metadata: mergeMetadata(
                existing.metadata,
                normalizeOptionalRecord(
                  contextRecord.metadata,
                  `pageContexts[${index}].metadata`,
                ),
              ),
            }
          : createLifeOpsBrowserPageContext({
              agentId: this.agentId(),
              browser: contextBrowser,
              profileId: contextProfileId,
              windowId,
              tabId,
              url,
              title: requireNonEmptyString(
                contextRecord.title,
                `pageContexts[${index}].title`,
              ),
              selectionText: redactSecretLikeText(contextRecord.selectionText),
              mainText: redactSecretLikeText(contextRecord.mainText),
              headings: normalizePageHeadings(
                contextRecord.headings,
                `pageContexts[${index}].headings`,
              ),
              links: normalizePageLinks(
                contextRecord.links,
                `pageContexts[${index}].links`,
              ),
              forms: normalizePageForms(
                contextRecord.forms,
                `pageContexts[${index}].forms`,
              ),
              capturedAt:
                normalizeOptionalIsoString(
                  contextRecord.capturedAt,
                  `pageContexts[${index}].capturedAt`,
                ) ?? nowIso,
              metadata:
                normalizeOptionalRecord(
                  contextRecord.metadata,
                  `pageContexts[${index}].metadata`,
                ) ?? {},
            });
        await this.repository.upsertBrowserPageContext(nextContext);
        syncedContextIds.add(nextContext.id);
      }

      const keptKeys = new Set(keptTabs.map((tab) => browserTabIdentityKey(tab)));
      await this.repository.deleteBrowserPageContextsByIds(
        this.agentId(),
        existingContexts
          .filter((context) => {
            const key = browserPageContextIdentityKey(context);
            if (!keptKeys.has(key)) {
              return true;
            }
            if (
              context.browser === browser &&
              context.profileId === profileId &&
              !syncedContextIds.has(context.id) &&
              key !== focusedKey
            ) {
              return true;
            }
            return false;
          })
          .map((context) => context.id),
      );

      const currentPage = await this.getCurrentBrowserPage();
      return {
        companion,
        tabs: await this.listBrowserTabs(),
        currentPage,
      };
    }

    async createBrowserCompanionPairing(
      request: CreateLifeOpsBrowserCompanionPairingRequest,
    ): Promise<LifeOpsBrowserCompanionPairingResponse> {
      const browser = normalizeEnumValue(
        request.browser,
        "browser",
        LIFEOPS_BROWSER_KINDS,
      );
      const profileId = requireNonEmptyString(request.profileId, "profileId");
      const currentCompanion = await this.repository.getBrowserCompanionByProfile(
        this.agentId(),
        browser,
        profileId,
      );
      const profileLabel =
        normalizeOptionalString(request.profileLabel) ??
        currentCompanion?.profileLabel ??
        profileId;
      const label =
        normalizeOptionalString(request.label) ??
        currentCompanion?.label ??
        `LifeOps Browser ${browser} ${profileLabel}`;
      const companion = this.buildBrowserCompanion(
        {
          browser,
          profileId,
          profileLabel,
          label,
          extensionVersion: request.extensionVersion ?? null,
          connectionState: currentCompanion?.connectionState ?? "disconnected",
          permissions:
            currentCompanion?.permissions ?? DEFAULT_BROWSER_PERMISSION_STATE,
          lastSeenAt: currentCompanion?.lastSeenAt ?? null,
          metadata: request.metadata ?? currentCompanion?.metadata ?? {},
        },
        currentCompanion,
      );
      await this.repository.upsertBrowserCompanion(companion);
      const pairingToken = `lobr_${crypto.randomBytes(24).toString("base64url")}`;
      const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
      const nowIso = new Date().toISOString();
      const credential = await this.repository.getBrowserCompanionCredential(
        this.agentId(),
        companion.id,
      );
      if (!credential?.pairingTokenHash) {
        await this.repository.updateBrowserCompanionPairingToken(
          this.agentId(),
          companion.id,
          pairingTokenHash,
          nowIso,
          nowIso,
        );
      } else {
        const pendingPairingTokenHashes =
          normalizePendingBrowserPairingTokenHashes(
            [pairingTokenHash, ...(credential.pendingPairingTokenHashes ?? [])],
            credential.pairingTokenHash,
          );
        await this.repository.updateBrowserCompanionPendingPairingTokenHashes(
          this.agentId(),
          companion.id,
          pendingPairingTokenHashes,
          nowIso,
        );
      }
      return {
        companion: {
          ...companion,
          pairedAt: credential?.pairingTokenHash ? companion.pairedAt : nowIso,
          updatedAt: nowIso,
        },
        pairingToken,
      };
    }

    async autoPairBrowserCompanion(
      request: CreateLifeOpsBrowserCompanionAutoPairRequest,
      apiBaseUrl: string,
    ): Promise<LifeOpsBrowserCompanionAutoPairResponse> {
      const profileId = normalizeOptionalString(request.profileId) ?? "default";
      const profileLabel =
        normalizeOptionalString(request.profileLabel) ?? "Default";
      const label =
        normalizeOptionalString(request.label) ??
        `LifeOps Browser ${normalizeEnumValue(request.browser, "browser", LIFEOPS_BROWSER_KINDS)} ${profileLabel}`;
      const pairing = await this.createBrowserCompanionPairing({
        browser: request.browser,
        profileId,
        profileLabel,
        label,
        extensionVersion: request.extensionVersion ?? null,
        metadata: request.metadata,
      });
      const config: LifeOpsBrowserCompanionConfig = {
        apiBaseUrl: requireNonEmptyString(apiBaseUrl, "apiBaseUrl").replace(
          /\/+$/,
          "",
        ),
        companionId: pairing.companion.id,
        pairingToken: pairing.pairingToken,
        browser: pairing.companion.browser,
        profileId: pairing.companion.profileId,
        profileLabel: pairing.companion.profileLabel,
        label: pairing.companion.label,
      };
      return {
        companion: pairing.companion,
        config,
      };
    }

    async syncBrowserCompanion(
      companionId: string,
      pairingToken: string,
      request: SyncLifeOpsBrowserStateRequest,
    ): Promise<LifeOpsBrowserCompanionSyncResponse> {
      const companion = await this.requireBrowserCompanion(
        companionId,
        pairingToken,
      );
      const companionInput = requireRecord(request.companion, "companion");
      const browser = normalizeEnumValue(
        companionInput.browser,
        "companion.browser",
        LIFEOPS_BROWSER_KINDS,
      );
      const profileId = requireNonEmptyString(
        companionInput.profileId,
        "companion.profileId",
      );
      if (browser !== companion.browser || profileId !== companion.profileId) {
        fail(403, "browser companion payload does not match the paired profile");
      }
      const state = await this.syncBrowserState(request);
      const settings = await this.getBrowserSettings();
      const session =
        settings.enabled &&
        settings.trackingMode !== "off" &&
        !this.isBrowserPaused(settings) &&
        settings.allowBrowserControl
          ? await this.claimQueuedBrowserSession(state.companion)
          : null;
      return {
        ...state,
        settings,
        session,
      };
    }

    async listBrowserSessions(): Promise<LifeOpsBrowserSession[]> {
      return this.repository.listBrowserSessions(this.agentId());
    }

    async getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession> {
      const session = await this.repository.getBrowserSession(
        this.agentId(),
        sessionId,
      );
      if (!session) {
        fail(404, "browser session not found");
      }
      return session;
    }

    async createBrowserSession(
      request: CreateLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      return this.createBrowserSessionInternal(request);
    }

    async confirmBrowserSession(
      sessionId: string,
      request: ConfirmLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      const session = await this.getBrowserSession(sessionId);
      if (
        session.status !== "awaiting_confirmation" ||
        !session.awaitingConfirmationForActionId
      ) {
        fail(409, "browser session is not awaiting confirmation");
      }
      const confirmed =
        normalizeOptionalBoolean(request.confirmed, "confirmed") ?? false;
      const nextSession: LifeOpsBrowserSession = confirmed
        ? {
            ...session,
            status: "queued",
            awaitingConfirmationForActionId: null,
            updatedAt: new Date().toISOString(),
          }
        : {
            ...session,
            status: "cancelled",
            awaitingConfirmationForActionId: null,
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
      await this.repository.updateBrowserSession(nextSession);
      await this.recordBrowserAudit(
        "browser_session_updated",
        nextSession.id,
        confirmed ? "browser session confirmed" : "browser session cancelled",
        {
          confirmed,
        },
        {
          status: nextSession.status,
        },
      );
      return nextSession;
    }

    async completeBrowserSession(
      sessionId: string,
      request: CompleteLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      const session = await this.getBrowserSession(sessionId);
      if (
        session.status === "done" ||
        session.status === "failed" ||
        session.status === "cancelled"
      ) {
        fail(
          409,
          `browser session cannot complete from status ${session.status}`,
        );
      }
      if (
        session.status === "awaiting_confirmation" &&
        session.awaitingConfirmationForActionId
      ) {
        fail(
          409,
          "Browser session requires explicit confirmation before execution.",
        );
      }
      const nextSession: LifeOpsBrowserSession = {
        ...session,
        status:
          request.status === undefined
            ? "done"
            : normalizeEnumValue(request.status, "status", [
                "done",
                "failed",
              ] as const),
        currentActionIndex: Math.max(0, session.actions.length - 1),
        result:
          request.result === undefined
            ? session.result
            : {
                ...session.result,
                ...requireRecord(request.result, "result"),
              },
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.repository.updateBrowserSession(nextSession);
      await this.recordBrowserAudit(
        "browser_session_updated",
        nextSession.id,
        nextSession.status === "failed"
          ? "browser session failed"
          : "browser session completed",
        {
          result: request.result ?? null,
        },
        {
          status: nextSession.status,
        },
      );
      return nextSession;
    }

    async updateBrowserSessionProgressFromCompanion(
      companionId: string,
      pairingToken: string,
      sessionId: string,
      request: UpdateLifeOpsBrowserSessionProgressRequest,
    ): Promise<LifeOpsBrowserSession> {
      const companion = await this.requireBrowserCompanion(
        companionId,
        pairingToken,
      );
      const session = await this.requireBrowserSessionForCompanion(
        companion,
        sessionId,
      );
      if (
        session.status !== "queued" &&
        session.status !== "running" &&
        session.status !== "awaiting_confirmation"
      ) {
        fail(
          409,
          `browser session cannot update progress from status ${session.status}`,
        );
      }
      const nextSession: LifeOpsBrowserSession = {
        ...session,
        status: "running",
        currentActionIndex:
          request.currentActionIndex === undefined
            ? session.currentActionIndex
            : normalizeBrowserSessionActionIndex(
                request.currentActionIndex,
                session.actions.length,
              ),
        result:
          request.result === undefined
            ? session.result
            : {
                ...session.result,
                ...requireRecord(request.result, "result"),
              },
        metadata:
          request.metadata === undefined
            ? session.metadata
            : mergeMetadata(
                session.metadata,
                requireRecord(request.metadata, "metadata"),
              ),
        updatedAt: new Date().toISOString(),
      };
      await this.repository.updateBrowserSession(nextSession);
      return nextSession;
    }

    async completeBrowserSessionFromCompanion(
      companionId: string,
      pairingToken: string,
      sessionId: string,
      request: CompleteLifeOpsBrowserSessionRequest,
    ): Promise<LifeOpsBrowserSession> {
      const companion = await this.requireBrowserCompanion(
        companionId,
        pairingToken,
      );
      await this.requireBrowserSessionForCompanion(companion, sessionId);
      return this.completeBrowserSession(sessionId, request);
    }
  }

  return LifeOpsBrowserServiceMixin;
}

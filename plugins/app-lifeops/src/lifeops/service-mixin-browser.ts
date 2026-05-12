// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import crypto from "node:crypto";
import {
  BROWSER_BRIDGE_KINDS,
  type BrowserBridgeCompanionAutoPairResponse,
  type BrowserBridgeCompanionConfig,
  type BrowserBridgeCompanionPairingResponse,
  type BrowserBridgeCompanionRevokeResponse,
  type BrowserBridgeCompanionStatus,
  type BrowserBridgeCompanionSyncResponse,
  type BrowserBridgePageContext,
  type BrowserBridgeSettings,
  type BrowserBridgeTabSummary,
  type CreateBrowserBridgeCompanionAutoPairRequest,
  type CreateBrowserBridgeCompanionPairingRequest,
  type SyncBrowserBridgeStateRequest,
  type UpdateBrowserBridgeSettingsRequest,
} from "@elizaos/plugin-browser";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
  UpdateLifeOpsBrowserSessionProgressRequest,
} from "../contracts/index.js";
import { authenticateBrowserBridgeCompanionCredential } from "./browser-bridge-companion-auth.js";
import { recordBrowserFocusWindow } from "./browser-extension-store.js";
import {
  browserPageContextIdentityKey,
  browserSessionMatchesCompanion,
  browserTabIdentityKey,
  browserUrlAllowedBySettings,
  createBrowserSessionActions,
  hashBrowserCompanionPairingToken,
  normalizeBrowserSessionActionIndex,
  normalizePageForms,
  normalizePageHeadings,
  normalizePageLinks,
  normalizePendingBrowserPairingTokenHashes,
  redactSecretLikeText,
  resolveAwaitingBrowserActionId,
  selectRememberedBrowserTabs,
} from "./service-helpers-browser.js";
import {
  normalizeOptionalRecord,
  requireRecord,
} from "./service-helpers-misc.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalBoolean,
  normalizeOptionalIsoString,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import { normalizeBrowserActionInput } from "./service-normalize-task.js";

export interface BrowserBridgeService {
  getBrowserSettings(): Promise<BrowserBridgeSettings>;
  updateBrowserSettings(
    request: UpdateBrowserBridgeSettingsRequest,
  ): Promise<BrowserBridgeSettings>;
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
  listBrowserTabs(): Promise<BrowserBridgeTabSummary[]>;
  getCurrentBrowserPage(): Promise<BrowserBridgePageContext | null>;
  syncBrowserState(request: SyncBrowserBridgeStateRequest): Promise<{
    companion: BrowserBridgeCompanionStatus;
    tabs: BrowserBridgeTabSummary[];
    currentPage: BrowserBridgePageContext | null;
  }>;
  createBrowserCompanionPairing(
    request: CreateBrowserBridgeCompanionPairingRequest,
  ): Promise<BrowserBridgeCompanionPairingResponse>;
  syncBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: SyncBrowserBridgeStateRequest,
  ): Promise<BrowserBridgeCompanionSyncResponse>;
  listBrowserSessions(): Promise<LifeOpsBrowserSession[]>;
  getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession>;
  createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  confirmBrowserSession(
    sessionId: string,
    request: ConfirmLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  completeBrowserSession(
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  updateBrowserSessionProgressFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: UpdateLifeOpsBrowserSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession>;
  completeBrowserSessionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: CompleteLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  autoPairBrowserCompanion(
    request: CreateBrowserBridgeCompanionAutoPairRequest,
    apiBaseUrl: string,
  ): Promise<BrowserBridgeCompanionAutoPairResponse>;
  revokeBrowserCompanion(
    companionId: string,
  ): Promise<BrowserBridgeCompanionRevokeResponse>;
  revokeBrowserCompanionFromCompanion(
    companionId: string,
    pairingToken: string,
  ): Promise<BrowserBridgeCompanionRevokeResponse>;
  updateBrowserSessionProgress(
    sessionId: string,
    request: UpdateLifeOpsBrowserSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession>;
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

const MAX_BROWSER_FOCUS_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function browserCompanionPairingTokenTtlMs(): number {
  const raw =
    process.env.BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS ??
    process.env.ELIZA_BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return DEFAULT_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS;
}

function browserCompanionPairingTokenExpiresAt(nowMs = Date.now()): string {
  return new Date(nowMs + browserCompanionPairingTokenTtlMs()).toISOString();
}

function isoTimestampExpired(
  value: string | null | undefined,
  nowMs: number,
): boolean {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
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

function normalizeBrowserSettingsUpdate(
  request: UpdateBrowserBridgeSettingsRequest,
  current: BrowserBridgeSettings,
): BrowserBridgeSettings {
  return {
    ...current,
    enabled:
      normalizeOptionalBoolean(request.enabled, "enabled") ?? current.enabled,
    trackingMode: request.trackingMode ?? current.trackingMode,
    allowBrowserControl:
      normalizeOptionalBoolean(
        request.allowBrowserControl,
        "allowBrowserControl",
      ) ?? current.allowBrowserControl,
    requireConfirmationForAccountAffecting:
      normalizeOptionalBoolean(
        request.requireConfirmationForAccountAffecting,
        "requireConfirmationForAccountAffecting",
      ) ?? current.requireConfirmationForAccountAffecting,
    incognitoEnabled:
      normalizeOptionalBoolean(request.incognitoEnabled, "incognitoEnabled") ??
      current.incognitoEnabled,
    siteAccessMode: request.siteAccessMode ?? current.siteAccessMode,
    grantedOrigins: request.grantedOrigins ?? [...current.grantedOrigins],
    blockedOrigins: request.blockedOrigins ?? [...current.blockedOrigins],
    maxRememberedTabs: request.maxRememberedTabs ?? current.maxRememberedTabs,
    pauseUntil:
      request.pauseUntil !== undefined
        ? (request.pauseUntil ?? null)
        : current.pauseUntil,
    metadata:
      request.metadata !== undefined
        ? mergeMetadata(
            current.metadata,
            normalizeOptionalRecord(request.metadata, "metadata"),
          )
        : current.metadata,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeOptionalBrowserKind(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeEnumValue(value, field, BROWSER_BRIDGE_KINDS);
}

import {
  mergeBrowserTaskLifecycle,
  summarizeBrowserTaskLifecycle,
} from "./browser-session-lifecycle.js";
// Imports from repository
import {
  createBrowserBridgePageContext,
  createBrowserBridgeTabSummary,
  createLifeOpsBrowserSession,
} from "./repository.js";
import { DEFAULT_BROWSER_PERMISSION_STATE } from "./service-constants.js";

// ---------------------------------------------------------------------------
// Browser mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withBrowser<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, BrowserBridgeService> {
  return class extends Base {
    protected async createBrowserSessionInternal(
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
      const lifecycle = mergeBrowserTaskLifecycle({
        session,
        now: new Date().toISOString(),
      });
      const initializedSession: LifeOpsBrowserSession = {
        ...session,
        result: lifecycle.result,
        metadata: lifecycle.metadata,
      };
      await this.repository.createBrowserSession(initializedSession);
      await this.recordBrowserAudit(
        "browser_session_created",
        initializedSession.id,
        "browser session created",
        {
          workflowId: initializedSession.workflowId,
          title: initializedSession.title,
          browser: initializedSession.browser,
          profileId: initializedSession.profileId,
          windowId: initializedSession.windowId,
          tabId: initializedSession.tabId,
        },
        {
          status: initializedSession.status,
          actionCount: initializedSession.actions.length,
        },
      );
      return initializedSession;
    }

    public async requireBrowserCompanion(
      companionId: string,
      pairingToken: string,
    ): Promise<BrowserBridgeCompanionStatus> {
      const nowMs = Date.now();
      const credential = await this.repository.getBrowserCompanionCredential(
        this.agentId(),
        requireNonEmptyString(companionId, "companionId"),
      );
      const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
      const auth = authenticateBrowserBridgeCompanionCredential({
        credential,
        pairingTokenHash,
        nowMs,
      });
      if (!auth.ok) {
        fail(401, auth.message, auth.code);
      }
      if (auth.source === "active") {
        return credential.companion;
      }
      const nowIso = new Date().toISOString();
      const remainingPendingPairingTokens =
        normalizePendingBrowserPairingTokenHashes(
          auth.remainingPendingPairingTokens.map((candidate) => candidate.hash),
          pairingTokenHash,
        ).map((hash) => {
          const previous = auth.remainingPendingPairingTokens.find(
            (candidate) => candidate.hash === hash,
          );
          return {
            hash,
            expiresAt: previous?.expiresAt ?? null,
          };
        });
      const expiresAt =
        auth.expiresAt ?? browserCompanionPairingTokenExpiresAt(nowMs);
      await this.repository.promoteBrowserCompanionPendingPairingToken(
        this.agentId(),
        credential.companion.id,
        pairingTokenHash,
        remainingPendingPairingTokens,
        expiresAt,
        nowIso,
        nowIso,
      );
      return {
        ...credential.companion,
        pairingTokenExpiresAt: expiresAt,
        pairingTokenRevokedAt: null,
        pairedAt: nowIso,
        updatedAt: nowIso,
      };
    }

    public async claimQueuedBrowserSession(
      companion: BrowserBridgeCompanionStatus,
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
      companion: BrowserBridgeCompanionStatus,
      sessionId: string,
    ): Promise<LifeOpsBrowserSession> {
      const session = await this.getBrowserSession(sessionId);
      if (!browserSessionMatchesCompanion(session, companion)) {
        fail(403, "browser session does not belong to this browser companion");
      }
      return session;
    }

    async getBrowserSettings(): Promise<BrowserBridgeSettings> {
      return this.getBrowserSettingsInternal();
    }

    async updateBrowserSettings(
      request: UpdateBrowserBridgeSettingsRequest,
    ): Promise<BrowserBridgeSettings> {
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

    async listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]> {
      return this.repository.listBrowserCompanions(this.agentId());
    }

    async listBrowserTabs(): Promise<BrowserBridgeTabSummary[]> {
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

    async getCurrentBrowserPage(): Promise<BrowserBridgePageContext | null> {
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

    async syncBrowserState(request: SyncBrowserBridgeStateRequest): Promise<{
      companion: BrowserBridgeCompanionStatus;
      tabs: BrowserBridgeTabSummary[];
      currentPage: BrowserBridgePageContext | null;
    }> {
      const companionInput = requireRecord(request.companion, "companion");
      const browser = normalizeEnumValue(
        companionInput.browser,
        "companion.browser",
        BROWSER_BRIDGE_KINDS,
      );
      const profileId = requireNonEmptyString(
        companionInput.profileId,
        "companion.profileId",
      );
      const currentCompanion =
        await this.repository.getBrowserCompanionByProfile(
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
      const existingTabs = await this.repository.listBrowserTabs(
        this.agentId(),
      );
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
          BROWSER_BRIDGE_KINDS,
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
          : createBrowserBridgeTabSummary({
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
        const contextRecord = requireRecord(
          candidate,
          `pageContexts[${index}]`,
        );
        const contextBrowser = normalizeEnumValue(
          contextRecord.browser,
          `pageContexts[${index}].browser`,
          BROWSER_BRIDGE_KINDS,
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
          : createBrowserBridgePageContext({
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

      const keptKeys = new Set(
        keptTabs.map((tab) => browserTabIdentityKey(tab)),
      );
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
      request: CreateBrowserBridgeCompanionPairingRequest,
    ): Promise<BrowserBridgeCompanionPairingResponse> {
      const browser = normalizeEnumValue(
        request.browser,
        "browser",
        BROWSER_BRIDGE_KINDS,
      );
      const profileId = requireNonEmptyString(request.profileId, "profileId");
      const currentCompanion =
        await this.repository.getBrowserCompanionByProfile(
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
        `Agent Browser Bridge ${browser} ${profileLabel}`;
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
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const pairingTokenExpiresAt =
        browserCompanionPairingTokenExpiresAt(nowMs);
      const credential = await this.repository.getBrowserCompanionCredential(
        this.agentId(),
        companion.id,
      );
      const replaceActiveToken =
        !credential?.pairingTokenHash ||
        Boolean(credential.companion.pairingTokenRevokedAt) ||
        isoTimestampExpired(credential.companion.pairingTokenExpiresAt, nowMs);
      if (replaceActiveToken) {
        await this.repository.updateBrowserCompanionPairingToken(
          this.agentId(),
          companion.id,
          pairingTokenHash,
          pairingTokenExpiresAt,
          nowIso,
          nowIso,
        );
      } else {
        const existingPendingPairingTokens =
          credential.pendingPairingTokens ??
          (credential.pendingPairingTokenHashes ?? []).map((hash) => ({
            hash,
            expiresAt: null,
          }));
        const pendingPairingTokens = normalizePendingBrowserPairingTokenHashes(
          [
            pairingTokenHash,
            ...existingPendingPairingTokens.map((candidate) => candidate.hash),
          ],
          credential.pairingTokenHash,
        ).map((hash) => {
          if (hash === pairingTokenHash) {
            return { hash, expiresAt: pairingTokenExpiresAt };
          }
          const previous = existingPendingPairingTokens.find(
            (candidate) => candidate.hash === hash,
          );
          return { hash, expiresAt: previous?.expiresAt ?? null };
        });
        await this.repository.updateBrowserCompanionPendingPairingTokenHashes(
          this.agentId(),
          companion.id,
          pendingPairingTokens,
          nowIso,
        );
      }
      return {
        companion: {
          ...companion,
          pairingTokenExpiresAt: replaceActiveToken
            ? pairingTokenExpiresAt
            : (credential?.companion.pairingTokenExpiresAt ??
              companion.pairingTokenExpiresAt ??
              null),
          pairingTokenRevokedAt: replaceActiveToken
            ? null
            : (credential?.companion.pairingTokenRevokedAt ??
              companion.pairingTokenRevokedAt ??
              null),
          pairedAt: replaceActiveToken ? nowIso : companion.pairedAt,
          updatedAt: nowIso,
        },
        pairingToken,
        pairingTokenExpiresAt,
      };
    }

    async autoPairBrowserCompanion(
      request: CreateBrowserBridgeCompanionAutoPairRequest,
      apiBaseUrl: string,
    ): Promise<BrowserBridgeCompanionAutoPairResponse> {
      const profileId = normalizeOptionalString(request.profileId) ?? "default";
      const profileLabel =
        normalizeOptionalString(request.profileLabel) ?? "Default";
      const label =
        normalizeOptionalString(request.label) ??
        `Agent Browser Bridge ${normalizeEnumValue(request.browser, "browser", BROWSER_BRIDGE_KINDS)} ${profileLabel}`;
      const pairing = await this.createBrowserCompanionPairing({
        browser: request.browser,
        profileId,
        profileLabel,
        label,
        extensionVersion: request.extensionVersion ?? null,
        metadata: request.metadata,
      });
      const config: BrowserBridgeCompanionConfig = {
        apiBaseUrl: requireNonEmptyString(apiBaseUrl, "apiBaseUrl")
          .slice(0, 2048)
          .replace(/\/{1,256}$/, ""),
        companionId: pairing.companion.id,
        pairingToken: pairing.pairingToken,
        pairingTokenExpiresAt: pairing.pairingTokenExpiresAt,
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

    async revokeBrowserCompanion(
      companionId: string,
    ): Promise<BrowserBridgeCompanionRevokeResponse> {
      const normalizedCompanionId = requireNonEmptyString(
        companionId,
        "companionId",
      );
      const credential = await this.repository.getBrowserCompanionCredential(
        this.agentId(),
        normalizedCompanionId,
      );
      if (!credential) {
        fail(404, "browser companion not found");
      }
      const revokedAt = new Date().toISOString();
      await this.repository.revokeBrowserCompanionPairingToken(
        this.agentId(),
        normalizedCompanionId,
        revokedAt,
      );
      return {
        companion: {
          ...credential.companion,
          connectionState: "disconnected",
          pairingTokenRevokedAt: revokedAt,
          updatedAt: revokedAt,
        },
        revokedAt,
      };
    }

    async revokeBrowserCompanionFromCompanion(
      companionId: string,
      pairingToken: string,
    ): Promise<BrowserBridgeCompanionRevokeResponse> {
      const companion = await this.requireBrowserCompanion(
        companionId,
        pairingToken,
      );
      return this.revokeBrowserCompanion(companion.id);
    }

    async syncBrowserCompanion(
      companionId: string,
      pairingToken: string,
      request: SyncBrowserBridgeStateRequest,
    ): Promise<BrowserBridgeCompanionSyncResponse> {
      const companion = await this.requireBrowserCompanion(
        companionId,
        pairingToken,
      );
      const companionInput = requireRecord(request.companion, "companion");
      const browser = normalizeEnumValue(
        companionInput.browser,
        "companion.browser",
        BROWSER_BRIDGE_KINDS,
      );
      const profileId = requireNonEmptyString(
        companionInput.profileId,
        "companion.profileId",
      );
      if (browser !== companion.browser || profileId !== companion.profileId) {
        fail(
          403,
          "browser companion payload does not match the paired profile",
        );
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
      const lifecycle = mergeBrowserTaskLifecycle({
        session: nextSession,
        now: nextSession.updatedAt,
        approvalSatisfied: confirmed,
        completed: !confirmed ? false : undefined,
      });
      const finalizedSession: LifeOpsBrowserSession = {
        ...nextSession,
        result: lifecycle.result,
        metadata: lifecycle.metadata,
      };
      await this.repository.updateBrowserSession(finalizedSession);
      await this.recordBrowserAudit(
        "browser_session_updated",
        finalizedSession.id,
        confirmed ? "browser session confirmed" : "browser session cancelled",
        {
          confirmed,
        },
        {
          status: finalizedSession.status,
        },
      );
      return finalizedSession;
    }

    async updateBrowserSessionProgress(
      sessionId: string,
      request: UpdateLifeOpsBrowserSessionProgressRequest,
    ): Promise<LifeOpsBrowserSession> {
      const session = await this.getBrowserSession(sessionId);
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
      const updatedAt = new Date().toISOString();
      const lifecycle = mergeBrowserTaskLifecycle({
        session,
        resultPatch:
          request.result === undefined
            ? undefined
            : requireRecord(request.result, "result"),
        metadataPatch:
          request.metadata === undefined
            ? undefined
            : requireRecord(request.metadata, "metadata"),
        now: updatedAt,
      });
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
        result: lifecycle.result,
        metadata: lifecycle.metadata,
        updatedAt,
      };
      await this.repository.updateBrowserSession(nextSession);
      await this.recordBrowserAudit(
        "browser_session_updated",
        nextSession.id,
        "browser session progress updated",
        {
          currentActionIndex: nextSession.currentActionIndex,
          browserTask: summarizeBrowserTaskLifecycle(nextSession),
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
      const updatedAt = new Date().toISOString();
      const lifecycle = mergeBrowserTaskLifecycle({
        session,
        resultPatch:
          request.result === undefined
            ? undefined
            : requireRecord(request.result, "result"),
        now: updatedAt,
        completed:
          request.status === "failed"
            ? false
            : request.status === "done" || request.status === undefined,
      });
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
        result: lifecycle.result,
        metadata: lifecycle.metadata,
        finishedAt: new Date().toISOString(),
        updatedAt,
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
      return this.updateBrowserSessionProgress(session.id, request);
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
  } as MixinClass<TBase, BrowserBridgeService>;
}

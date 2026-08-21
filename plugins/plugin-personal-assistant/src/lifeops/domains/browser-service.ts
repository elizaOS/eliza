/**
 * Browser-companion domain for LifeOps: projects the browser-bridge companion
 * (pairing, tab summaries, page context, session lifecycle) from
 * `@elizaos/plugin-browser` into the assistant's connector DTOs. The transport
 * and CDP implementation live in the browser plugin; this layer owns only the
 * owner-facing projection and session state.
 */
import crypto from "node:crypto";
import {
  authenticateBrowserBridgeCompanionCredential,
  BROWSER_BRIDGE_KINDS,
  type BrowserBridgeAction,
  type BrowserBridgeCompanionPairingResponse,
  type BrowserBridgeCompanionPreflightRequest,
  type BrowserBridgeCompanionPreflightResponse,
  type BrowserBridgeCompanionRevocationResetResponse,
  type BrowserBridgeCompanionRevokeResponse,
  type BrowserBridgeCompanionSessionBeginRequest,
  type BrowserBridgeCompanionSessionProgressRequest,
  type BrowserBridgeCompanionStatus,
  type BrowserBridgeCompanionSyncRequest,
  type BrowserBridgeCompanionSyncResponse,
  type BrowserBridgeKind,
  type BrowserBridgePageContext,
  type BrowserBridgeSettings,
  type BrowserBridgeTabSummary,
  browserBridgeDomainFromUrl,
  type CreateBrowserBridgeCompanionPairingRequest,
  createBrowserBridgePageContext,
  createBrowserBridgeTabSummary,
  isoTimestampExpired,
  MAX_BROWSER_FOCUS_WINDOW_MS,
  resolveBrowserBridgeCompanionPairingTokenExpiresAt,
  type SyncBrowserBridgeStateRequest,
  type UpdateBrowserBridgeSettingsRequest,
  type UpsertBrowserBridgeCompanionRequest,
} from "@elizaos/plugin-browser";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserSession,
  LifeOpsScreenTimeSession,
  LifeOpsWorkflowDefinition,
  UpdateLifeOpsBrowserSessionProgressRequest,
} from "../../contracts/index.js";
import { DEFAULT_BROWSER_PERMISSION_STATE } from "../browser-constants.js";
import { recordBrowserFocusWindow } from "../browser-extension-store.js";
import {
  mergeBrowserTaskLifecycle,
  summarizeBrowserTaskLifecycle,
} from "../browser-session-lifecycle.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import { createLifeOpsBrowserSession } from "../repository.js";
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
} from "../service-helpers-browser.js";
import {
  normalizeOptionalRecord,
  requireRecord,
} from "../service-helpers-misc.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalBoolean,
  normalizeOptionalIsoString,
  normalizeOptionalString,
  requireNonEmptyString,
} from "../service-normalize.js";
import { normalizeBrowserActionInput } from "../service-normalize-task.js";

type BrowserScreenTimeEvent = {
  source: "app" | "website";
  identifier: string;
  displayName: string;
  startAt: string;
  endAt?: string | null;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
};

function canonicalizeSettingsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeSettingsValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeSettingsValue(entry)]),
    );
  }
  return value;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalizeSettingsValue(left)) ===
    JSON.stringify(canonicalizeSettingsValue(right))
  );
}

function recordPatchMatches(
  current: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): boolean {
  return (
    patch === undefined ||
    Object.entries(patch).every(([key, value]) =>
      sameCanonicalValue(current[key], value),
    )
  );
}

export function browserBridgeSettingsVersion(
  settings: BrowserBridgeSettings,
): string {
  const canonical = JSON.stringify(canonicalizeSettingsValue(settings));
  return `bbsv1_${crypto.createHash("sha256").update(canonical).digest("base64url")}`;
}

export function browserSessionActionsDigest(
  actions: readonly BrowserBridgeAction[],
): string {
  const canonical = JSON.stringify(canonicalizeSettingsValue(actions));
  return `bbad1_${crypto.createHash("sha256").update(canonical).digest("base64url")}`;
}

function browserActionNeedsApproval(
  action: BrowserBridgeAction,
  settings: BrowserBridgeSettings,
): boolean {
  return (
    action.requiresConfirmation ||
    (settings.requireConfirmationForAccountAffecting && action.accountAffecting)
  );
}

export const MAX_BROWSER_SESSION_APPROVAL_AGE_MS = 2 * 60 * 1000;

function hasCurrentBrowserSessionApproval(
  session: LifeOpsBrowserSession,
  nowMs = Date.now(),
): boolean {
  const approval = session.metadata.browserApproval;
  const confirmedAt =
    approval !== null &&
    typeof approval === "object" &&
    !Array.isArray(approval) &&
    typeof (approval as Record<string, unknown>).confirmedAt === "string"
      ? Date.parse((approval as Record<string, unknown>).confirmedAt as string)
      : Number.NaN;
  return (
    approval !== null &&
    typeof approval === "object" &&
    !Array.isArray(approval) &&
    (approval as Record<string, unknown>).actionsDigest ===
      browserSessionActionsDigest(session.actions) &&
    Number.isFinite(confirmedAt) &&
    confirmedAt <= nowMs &&
    nowMs - confirmedAt <= MAX_BROWSER_SESSION_APPROVAL_AGE_MS
  );
}

/**
 * Base browser helpers and the cross-domain screen-time recorder the browser
 * domain depends on. `getBrowserSettingsInternal`, `isBrowserPaused`,
 * `requireBrowserAvailableForActions`, `buildBrowserCompanion`,
 * `recordBrowserAudit` and `getWorkflowDefinition` live on
 * `LifeOpsServiceBase`; `recordScreenTimeEvent` lives on the screen-time domain
 * (`withScreenTime`). All are injected as typed callbacks rather than read off
 * {@link LifeOpsContext}.
 */
export type BrowserDomainDeps = {
  getBrowserSettingsInternal(): Promise<BrowserBridgeSettings>;
  isBrowserPaused(settings: BrowserBridgeSettings): boolean;
  requireBrowserAvailableForActions(
    actions: readonly BrowserBridgeAction[],
  ): Promise<BrowserBridgeSettings>;
  buildBrowserCompanion(
    request: UpsertBrowserBridgeCompanionRequest,
    current: BrowserBridgeCompanionStatus | null,
  ): BrowserBridgeCompanionStatus;
  recordBrowserAudit(
    eventType: "browser_session_created" | "browser_session_updated",
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void>;
  getWorkflowDefinition(workflowId: string): Promise<LifeOpsWorkflowDefinition>;
  recordScreenTimeEvent(
    event: BrowserScreenTimeEvent,
  ): Promise<LifeOpsScreenTimeSession>;
};

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
): BrowserBridgeKind | null {
  if (value === undefined || value === null) return null;
  return normalizeEnumValue(value, field, BROWSER_BRIDGE_KINDS);
}

export class BrowserDomain {
  constructor(
    private readonly ctx: LifeOpsContext,
    private readonly deps: BrowserDomainDeps,
  ) {}

  public async createBrowserSessionInternal(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession> {
    const workflowId = normalizeOptionalString(request.workflowId) ?? null;
    const workflow = workflowId
      ? await this.deps.getWorkflowDefinition(workflowId)
      : null;
    const ownership = workflow
      ? this.ctx.normalizeChildOwnership(workflow, request.ownership)
      : this.ctx.normalizeOwnership(request.ownership);
    const actions = createBrowserSessionActions(
      request.actions.map((action, index) =>
        normalizeBrowserActionInput(action, `actions[${index}]`),
      ),
    );
    const settings = await this.deps.requireBrowserAvailableForActions(actions);
    const awaitingActionId = resolveAwaitingBrowserActionId(
      actions,
      settings.requireConfirmationForAccountAffecting,
    );
    const session = createLifeOpsBrowserSession({
      agentId: this.ctx.agentId(),
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
    await this.ctx.repository.createBrowserSession(initializedSession);
    await this.deps.recordBrowserAudit(
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
    const credential = await this.ctx.repository.getBrowserCompanionCredential(
      this.ctx.agentId(),
      requireNonEmptyString(companionId, "companionId"),
    );
    const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
    const auth = authenticateBrowserBridgeCompanionCredential({
      credential,
      pairingTokenHash,
      nowMs,
    });
    if (auth.ok === false) {
      fail(401, auth.message, auth.code);
    }
    if (!credential) {
      // Unreachable when auth.ok is true (the authenticator rejects a missing
      // credential), but the type system can't see that correlation.
      fail(404, "Browser companion credential not found");
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
      auth.expiresAt ??
      resolveBrowserBridgeCompanionPairingTokenExpiresAt(nowMs);
    await this.ctx.repository.promoteBrowserCompanionPendingPairingToken(
      this.ctx.agentId(),
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
    const nowIso = new Date().toISOString();
    const claimed = await this.ctx.repository.claimBrowserSession(
      this.ctx.agentId(),
      companion,
      nowIso,
    );
    if (!claimed) {
      return null;
    }
    await this.deps.recordBrowserAudit(
      "browser_session_updated",
      claimed.id,
      "browser session claimed by companion",
      {
        companionId: companion.id,
        browser: companion.browser,
        profileId: companion.profileId,
      },
      {
        status: claimed.status,
      },
    );
    return claimed;
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
    return this.deps.getBrowserSettingsInternal();
  }

  async updateBrowserSettings(
    request: UpdateBrowserBridgeSettingsRequest,
  ): Promise<BrowserBridgeSettings> {
    const current = await this.deps.getBrowserSettingsInternal();
    const next = normalizeBrowserSettingsUpdate(request, current);
    await this.ctx.repository.upsertBrowserSettings(this.ctx.agentId(), next);
    if (
      !next.enabled ||
      next.trackingMode === "off" ||
      this.deps.isBrowserPaused(next)
    ) {
      await this.ctx.repository.deleteAllBrowserTabs(this.ctx.agentId());
      await this.ctx.repository.deleteAllBrowserPageContexts(
        this.ctx.agentId(),
      );
    }
    return this.deps.getBrowserSettingsInternal();
  }

  async listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]> {
    return this.ctx.repository.listBrowserCompanions(this.ctx.agentId());
  }

  async listBrowserTabs(): Promise<BrowserBridgeTabSummary[]> {
    const settings = await this.deps.getBrowserSettingsInternal();
    if (
      !settings.enabled ||
      settings.trackingMode === "off" ||
      this.deps.isBrowserPaused(settings)
    ) {
      return [];
    }
    const tabs = await this.ctx.repository.listBrowserTabs(this.ctx.agentId());
    return selectRememberedBrowserTabs(
      tabs.filter((tab) => browserUrlAllowedBySettings(tab.url, settings)),
      settings.maxRememberedTabs,
    );
  }

  async getCurrentBrowserPage(): Promise<BrowserBridgePageContext | null> {
    const settings = await this.deps.getBrowserSettingsInternal();
    if (
      !settings.enabled ||
      settings.trackingMode === "off" ||
      this.deps.isBrowserPaused(settings)
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
    const contexts = await this.ctx.repository.listBrowserPageContexts(
      this.ctx.agentId(),
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
      await this.ctx.repository.getBrowserCompanionByProfile(
        this.ctx.agentId(),
        browser,
        profileId,
      );
    const companion = this.deps.buildBrowserCompanion(
      request.companion,
      currentCompanion,
    );
    await this.ctx.repository.upsertBrowserCompanion(companion);

    const settings = await this.deps.getBrowserSettingsInternal();
    if (
      !settings.enabled ||
      settings.trackingMode === "off" ||
      this.deps.isBrowserPaused(settings)
    ) {
      await this.ctx.repository.deleteAllBrowserTabs(this.ctx.agentId());
      await this.ctx.repository.deleteAllBrowserPageContexts(
        this.ctx.agentId(),
      );
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
    const allExistingTabs = await this.ctx.repository.listBrowserTabs(
      this.ctx.agentId(),
    );
    const existingTabs = allExistingTabs.filter(
      (tab) =>
        tab.companionId === companion.id &&
        tab.browser === browser &&
        tab.profileId === profileId,
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
        await recordBrowserFocusWindow(this.ctx.runtime, {
          deviceId: companion.id,
          url: previouslyFocusedTab.url,
          windowStart: new Date(cappedStartMs).toISOString(),
          windowEnd: nowIso,
        });
        const domain = browserBridgeDomainFromUrl(previouslyFocusedTab.url);
        if (domain) {
          await this.deps.recordScreenTimeEvent({
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
            agentId: this.ctx.agentId(),
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
      await this.ctx.repository.upsertBrowserTab(nextTab);
    }

    const allTabs = await this.ctx.repository.listBrowserTabs(
      this.ctx.agentId(),
    );
    const currentCompanionTabs = allTabs.filter(
      (tab) =>
        tab.companionId === companion.id &&
        tab.browser === browser &&
        tab.profileId === profileId,
    );
    const companionTabs = selectRememberedBrowserTabs(
      currentCompanionTabs.filter((tab) =>
        browserUrlAllowedBySettings(tab.url, settings),
      ),
      settings.maxRememberedTabs,
    );
    const keptTabIds = new Set(companionTabs.map((tab) => tab.id));
    await this.ctx.repository.deleteBrowserTabsByIds(
      this.ctx.agentId(),
      currentCompanionTabs
        .filter((tab) => !keptTabIds.has(tab.id))
        .map((tab) => tab.id),
    );
    const focusedTab =
      companionTabs.find((tab) => tab.focusedActive) ??
      companionTabs.find((tab) => tab.activeInWindow) ??
      companionTabs[0] ??
      null;
    const focusedKey = focusedTab ? browserTabIdentityKey(focusedTab) : null;
    const existingContexts = await this.ctx.repository.listBrowserPageContexts(
      this.ctx.agentId(),
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
            agentId: this.ctx.agentId(),
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
      await this.ctx.repository.upsertBrowserPageContext(nextContext);
      syncedContextIds.add(nextContext.id);
    }

    const keptKeys = new Set(
      companionTabs.map((tab) => browserTabIdentityKey(tab)),
    );
    await this.ctx.repository.deleteBrowserPageContextsByIds(
      this.ctx.agentId(),
      existingContexts
        .filter((context) => {
          if (context.browser !== browser || context.profileId !== profileId) {
            return false;
          }
          const key = browserPageContextIdentityKey(context);
          if (!keptKeys.has(key)) {
            return true;
          }
          if (!syncedContextIds.has(context.id) && key !== focusedKey) {
            return true;
          }
          return false;
        })
        .map((context) => context.id),
    );

    const currentPage = focusedKey
      ? ((
          await this.ctx.repository.listBrowserPageContexts(this.ctx.agentId())
        ).find(
          (context) =>
            context.browser === browser &&
            context.profileId === profileId &&
            browserPageContextIdentityKey(context) === focusedKey &&
            browserUrlAllowedBySettings(context.url, settings),
        ) ?? null)
      : null;
    return {
      companion,
      tabs: companionTabs,
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
    const pairingKind = normalizeEnumValue(
      request.pairingKind ?? "manual",
      "pairingKind",
      ["manual", "native_enrollment"] as const,
    );
    const revocation = await this.ctx.repository.getBrowserCompanionRevocation(
      this.ctx.agentId(),
      this.ctx.ownerEntityId(),
      browser,
      profileId,
    );
    if (revocation) {
      fail(
        409,
        "Browser companion enrollment was revoked. Reset this browser profile in Eliza before reconnecting.",
        "revoked",
      );
    }
    const currentCompanion =
      await this.ctx.repository.getBrowserCompanionByProfile(
        this.ctx.agentId(),
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
    const companion = this.deps.buildBrowserCompanion(
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
    await this.ctx.repository.upsertBrowserCompanion(companion);
    const pairingToken = `lobr_${crypto.randomBytes(24).toString("base64url")}`;
    const pairingTokenHash = hashBrowserCompanionPairingToken(pairingToken);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const pairingTokenExpiresAt =
      resolveBrowserBridgeCompanionPairingTokenExpiresAt(
        nowMs,
        undefined,
        pairingKind,
      );
    const credential = await this.ctx.repository.getBrowserCompanionCredential(
      this.ctx.agentId(),
      companion.id,
    );
    const replaceActiveToken =
      !credential?.pairingTokenHash ||
      Boolean(credential.companion.pairingTokenRevokedAt) ||
      isoTimestampExpired(credential.companion.pairingTokenExpiresAt, nowMs);
    if (replaceActiveToken) {
      await this.ctx.repository.updateBrowserCompanionPairingToken(
        this.ctx.agentId(),
        companion.id,
        pairingTokenHash,
        pairingTokenExpiresAt,
        nowIso,
        nowIso,
      );
    } else {
      const existingPendingPairingTokens = credential.pendingPairingTokens;
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
      await this.ctx.repository.updateBrowserCompanionPendingPairingTokenHashes(
        this.ctx.agentId(),
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
          : (credential.companion.pairingTokenExpiresAt ??
            companion.pairingTokenExpiresAt ??
            null),
        pairingTokenRevokedAt: replaceActiveToken
          ? null
          : (credential.companion.pairingTokenRevokedAt ??
            companion.pairingTokenRevokedAt ??
            null),
        pairedAt: replaceActiveToken ? nowIso : companion.pairedAt,
        updatedAt: nowIso,
      },
      pairingToken,
      pairingTokenExpiresAt,
    };
  }

  async revokeBrowserCompanion(
    companionId: string,
  ): Promise<BrowserBridgeCompanionRevokeResponse> {
    const normalizedCompanionId = requireNonEmptyString(
      companionId,
      "companionId",
    );
    const credential = await this.ctx.repository.getBrowserCompanionCredential(
      this.ctx.agentId(),
      normalizedCompanionId,
    );
    if (!credential) {
      fail(404, "browser companion not found");
    }
    const revokedAt = new Date().toISOString();
    await this.ctx.repository.revokeBrowserCompanionWithTombstone({
      agentId: this.ctx.agentId(),
      ownerEntityId: this.ctx.ownerEntityId(),
      companion: credential.companion,
      revokedAt,
    });
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

  async resetBrowserCompanionRevocation(
    companionId: string,
  ): Promise<BrowserBridgeCompanionRevocationResetResponse> {
    const normalizedCompanionId = requireNonEmptyString(
      companionId,
      "companionId",
    );
    const credential = await this.ctx.repository.getBrowserCompanionCredential(
      this.ctx.agentId(),
      normalizedCompanionId,
    );
    if (!credential) {
      fail(404, "browser companion not found");
    }
    const resetAt = new Date().toISOString();
    const reset = await this.ctx.repository.resetBrowserCompanionRevocation({
      agentId: this.ctx.agentId(),
      ownerEntityId: this.ctx.ownerEntityId(),
      companion: credential.companion,
      resetAt,
    });
    if (!reset) {
      fail(409, "browser companion is not revoked");
    }
    return {
      companion: {
        ...credential.companion,
        connectionState: "disconnected",
        pairingTokenExpiresAt: null,
        pairingTokenRevokedAt: null,
        updatedAt: resetAt,
      },
      resetAt,
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
    request: BrowserBridgeCompanionSyncRequest,
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
      fail(403, "browser companion payload does not match the paired profile");
    }
    const settings = await this.getBrowserSettings();
    const settingsVersion = browserBridgeSettingsVersion(settings);
    if (
      typeof request.settingsVersion !== "string" ||
      request.settingsVersion !== settingsVersion
    ) {
      fail(
        409,
        "browser companion settings changed; preflight again",
        "browser_bridge_settings_stale",
      );
    }
    const state = await this.syncBrowserState(request);
    const session =
      settings.enabled &&
      settings.trackingMode !== "off" &&
      !this.deps.isBrowserPaused(settings) &&
      settings.allowBrowserControl
        ? await this.claimQueuedBrowserSession(state.companion)
        : null;
    return {
      ...state,
      settings,
      settingsVersion,
      session,
    };
  }

  async preflightBrowserCompanion(
    companionId: string,
    pairingToken: string,
    request: BrowserBridgeCompanionPreflightRequest,
  ): Promise<BrowserBridgeCompanionPreflightResponse> {
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
      fail(403, "browser companion payload does not match the paired profile");
    }
    const settings = await this.getBrowserSettings();
    return {
      companion,
      settings,
      settingsVersion: browserBridgeSettingsVersion(settings),
    };
  }

  async listBrowserSessions(): Promise<LifeOpsBrowserSession[]> {
    return this.ctx.repository.listBrowserSessions(this.ctx.agentId());
  }

  async getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession> {
    const session = await this.ctx.repository.getBrowserSession(
      this.ctx.agentId(),
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
      metadata: confirmed
        ? {
            ...lifecycle.metadata,
            browserApproval: {
              actionsDigest: browserSessionActionsDigest(session.actions),
              confirmedAt: nextSession.updatedAt,
            },
          }
        : lifecycle.metadata,
    };
    const persisted =
      await this.ctx.repository.updateBrowserSessionIfAwaitingConfirmation({
        session: finalizedSession,
        expectedActionId: session.awaitingConfirmationForActionId,
        expectedUpdatedAt: session.updatedAt,
      });
    if (!persisted) {
      fail(409, "browser session confirmation lost a concurrent update");
    }
    await this.deps.recordBrowserAudit(
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
    await this.ctx.repository.updateBrowserSession(nextSession);
    await this.deps.recordBrowserAudit(
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
      currentActionIndex: session.actions.length,
      result: lifecycle.result,
      metadata: lifecycle.metadata,
      finishedAt: new Date().toISOString(),
      updatedAt,
    };
    await this.ctx.repository.updateBrowserSession(nextSession);
    await this.deps.recordBrowserAudit(
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

  async beginBrowserSessionActionFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: BrowserBridgeCompanionSessionBeginRequest,
  ): Promise<LifeOpsBrowserSession> {
    const companion = await this.requireBrowserCompanion(
      companionId,
      pairingToken,
    );
    const session = await this.requireBrowserSessionForCompanion(
      companion,
      sessionId,
    );
    if (session.status !== "running") {
      fail(
        409,
        `browser session cannot begin an action from status ${session.status}`,
      );
    }
    const currentActionIndex = normalizeBrowserSessionActionIndex(
      request.currentActionIndex,
      session.actions.length,
    );
    if (currentActionIndex !== session.currentActionIndex) {
      fail(409, "browser action checkpoint is stale");
    }
    const actionId = requireNonEmptyString(request.actionId, "actionId");
    const attemptId = requireNonEmptyString(request.attemptId, "attemptId");
    if (attemptId.length > 128) {
      fail(400, "attemptId must be at most 128 characters");
    }
    const action = session.actions[currentActionIndex];
    if (!action || action.id !== actionId) {
      fail(409, "browser action does not match the current checkpoint");
    }
    const settings = await this.deps.requireBrowserAvailableForActions([
      action,
    ]);
    if (
      browserActionNeedsApproval(action, settings) &&
      !hasCurrentBrowserSessionApproval(session)
    ) {
      const awaiting =
        await this.ctx.repository.requireBrowserSessionActionConfirmation({
          agentId: this.ctx.agentId(),
          sessionId: session.id,
          companion,
          currentActionIndex,
          actionId,
          updatedAt: new Date().toISOString(),
        });
      if (!awaiting) {
        fail(409, "browser action confirmation lost a concurrent update");
      }
      fail(409, "Browser action requires current owner confirmation.");
    }
    const leased =
      await this.ctx.repository.beginBrowserSessionActionFromCompanion({
        agentId: this.ctx.agentId(),
        sessionId: session.id,
        companion,
        currentActionIndex,
        actionId,
        attemptId,
        startedAt: new Date().toISOString(),
      });
    if (!leased) {
      // Failing closed on an uncertain side effect is right — we cannot know
      // whether the previous attempt already clicked something. But the caller
      // does not transition the session to `failed` on a 409, so without an
      // audit record this wedges in `running` and silently re-loops on every
      // sync with no owner-visible signal. An unrecoverable state has to be
      // observable, not just safe.
      await this.deps.recordBrowserAudit(
        "browser_session_updated",
        session.id,
        "browser action lease blocked by an unresolved execution attempt",
        {
          sessionId: session.id,
          companionId: companion.id,
          currentActionIndex,
          actionId,
        },
        {
          outcome: "blocked",
          reason: "uncertain_or_concurrent_attempt",
          requiresOwnerRelease: true,
        },
      );
      fail(
        409,
        "browser action already has an uncertain or concurrent execution attempt",
      );
    }
    return leased;
  }

  async updateBrowserSessionProgressFromCompanion(
    companionId: string,
    pairingToken: string,
    sessionId: string,
    request: BrowserBridgeCompanionSessionProgressRequest,
  ): Promise<LifeOpsBrowserSession> {
    const companion = await this.requireBrowserCompanion(
      companionId,
      pairingToken,
    );
    const session = await this.requireBrowserSessionForCompanion(
      companion,
      sessionId,
    );
    if (session.status !== "running") {
      fail(
        409,
        `browser session cannot update progress from status ${session.status}`,
      );
    }
    const currentActionIndex =
      request.currentActionIndex === undefined
        ? session.currentActionIndex
        : normalizeBrowserSessionActionIndex(
            request.currentActionIndex,
            session.actions.length,
          );
    const completedActionId = requireNonEmptyString(
      request.completedActionId,
      "completedActionId",
    );
    const attemptId = requireNonEmptyString(request.attemptId, "attemptId");
    if (attemptId.length > 128) {
      fail(400, "attemptId must be at most 128 characters");
    }
    if (currentActionIndex < session.currentActionIndex) {
      fail(409, "browser session checkpoint cannot move backwards");
    }
    const resultPatch =
      request.result === undefined
        ? undefined
        : requireRecord(request.result, "result");
    const metadataPatch =
      request.metadata === undefined
        ? undefined
        : requireRecord(request.metadata, "metadata");
    if (
      metadataPatch &&
      ("browserActionAttempt" in metadataPatch ||
        "browserActionReceipt" in metadataPatch)
    ) {
      fail(400, "metadata contains reserved browser action receipt fields");
    }
    if (currentActionIndex === session.currentActionIndex) {
      const completedAction = session.actions[currentActionIndex - 1];
      if (!completedAction || completedAction.id !== completedActionId) {
        fail(
          409,
          "browser session checkpoint action does not match its receipt",
        );
      }
      const receipt = session.metadata.browserActionReceipt;
      const receiptMatches =
        receipt !== null &&
        typeof receipt === "object" &&
        !Array.isArray(receipt) &&
        (receipt as Record<string, unknown>).actionId === completedActionId &&
        (receipt as Record<string, unknown>).attemptId === attemptId &&
        (receipt as Record<string, unknown>).actionIndex ===
          currentActionIndex - 1;
      if (
        receiptMatches &&
        recordPatchMatches(session.result, resultPatch) &&
        recordPatchMatches(session.metadata, metadataPatch)
      ) {
        return session;
      }
      fail(409, "browser session checkpoint replay conflicts with its receipt");
    }
    if (currentActionIndex !== session.currentActionIndex + 1) {
      fail(409, "browser session checkpoint must advance exactly one action");
    }
    const expectedAction = session.actions[session.currentActionIndex];
    if (!expectedAction || expectedAction.id !== completedActionId) {
      fail(
        409,
        "browser session checkpoint action does not match the queued action",
      );
    }
    const updatedAt = new Date().toISOString();
    const lifecycle = mergeBrowserTaskLifecycle({
      session,
      resultPatch,
      metadataPatch,
      now: updatedAt,
    });
    const metadataWithoutAttempt = { ...lifecycle.metadata };
    delete metadataWithoutAttempt.browserActionAttempt;
    const receiptMetadata = {
      ...metadataWithoutAttempt,
      browserActionReceipt: {
        actionId: completedActionId,
        actionIndex: session.currentActionIndex,
        attemptId,
        completedAt: updatedAt,
      },
    };
    const updated =
      await this.ctx.repository.updateBrowserSessionProgressFromCompanion({
        agentId: this.ctx.agentId(),
        sessionId: session.id,
        companion,
        expectedActionIndex: session.currentActionIndex,
        completedActionId,
        attemptId,
        currentActionIndex,
        resultPatch: lifecycle.result,
        metadataPatch: receiptMetadata,
        updatedAt,
      });
    if (!updated) {
      fail(409, "browser session checkpoint lost a concurrent update");
    }
    await this.deps.recordBrowserAudit(
      "browser_session_updated",
      updated.id,
      "browser session progress updated",
      {
        currentActionIndex: updated.currentActionIndex,
        browserTask: summarizeBrowserTaskLifecycle(updated),
      },
      { status: updated.status },
    );
    return updated;
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
    const session = await this.requireBrowserSessionForCompanion(
      companion,
      sessionId,
    );
    const requestedResult =
      request.result === undefined
        ? undefined
        : requireRecord(request.result, "result");
    const status = normalizeEnumValue(request.status ?? "done", "status", [
      "done",
      "failed",
    ] as const);
    if (session.status !== "running") {
      if (
        session.status === status &&
        recordPatchMatches(session.result, requestedResult)
      ) {
        return session;
      }
      fail(
        409,
        `browser session cannot complete from status ${session.status}`,
      );
    }
    const updatedAt = new Date().toISOString();
    const currentActionIndex = normalizeBrowserSessionActionIndex(
      request.currentActionIndex,
      session.actions.length,
    );
    if (currentActionIndex !== session.currentActionIndex) {
      fail(409, "browser session completion checkpoint is stale");
    }
    const completedActionId = normalizeOptionalString(
      request.completedActionId,
    );
    const attemptId = normalizeOptionalString(request.attemptId);
    if ((completedActionId?.length ?? 0) > 128) {
      fail(400, "completedActionId must be at most 128 characters");
    }
    if ((attemptId?.length ?? 0) > 128) {
      fail(400, "attemptId must be at most 128 characters");
    }
    if (
      status === "done" &&
      session.currentActionIndex !== session.actions.length
    ) {
      fail(
        409,
        "browser session cannot complete before every action is acknowledged",
      );
    }
    if (status === "done" && session.actions.length > 0) {
      const lastAction = session.actions[session.actions.length - 1];
      if (
        !completedActionId ||
        completedActionId !== lastAction?.id ||
        !attemptId
      ) {
        fail(
          409,
          "browser session completion does not match its final receipt",
        );
      }
    }
    if (status === "failed") {
      const activeAction = session.actions[session.currentActionIndex];
      if (
        !completedActionId ||
        completedActionId !== activeAction?.id ||
        !attemptId
      ) {
        fail(409, "browser session failure does not match its active attempt");
      }
    }
    const lifecycle = mergeBrowserTaskLifecycle({
      session,
      resultPatch: requestedResult,
      now: updatedAt,
      completed: status === "done",
    });
    const completed =
      await this.ctx.repository.completeBrowserSessionFromCompanion({
        agentId: this.ctx.agentId(),
        sessionId,
        companion,
        status,
        expectedActionIndex: currentActionIndex,
        completedActionId,
        attemptId,
        resultPatch: lifecycle.result,
        updatedAt,
      });
    if (!completed) {
      const latest = await this.getBrowserSession(sessionId);
      if (
        latest.status === status &&
        latest.companionId === companion.id &&
        latest.browser === companion.browser &&
        latest.profileId === companion.profileId
      ) {
        return latest;
      }
      fail(409, "browser session completion lost a concurrent update");
    }
    await this.deps.recordBrowserAudit(
      "browser_session_updated",
      completed.id,
      status === "failed"
        ? "browser session failed"
        : "browser session completed",
      { result: request.result ?? null },
      { status: completed.status },
    );
    return completed;
  }
}

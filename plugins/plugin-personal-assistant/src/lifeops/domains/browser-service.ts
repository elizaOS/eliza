/** Reads legacy browser history and maintains stored session records for LifeOps. Companion enrollment and callbacks are retired. */
import crypto from "node:crypto";
import {
  BROWSER_BRIDGE_KINDS,
  type BrowserBridgeAction,
  type BrowserBridgeCompanionStatus,
  type BrowserBridgeKind,
  type BrowserBridgePageContext,
  type BrowserBridgeSettings,
  type BrowserBridgeTabSummary,
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
import {
  mergeBrowserTaskLifecycle,
  summarizeBrowserTaskLifecycle,
} from "../browser-session-lifecycle.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import { createLifeOpsBrowserSession } from "../repository.js";
import {
  browserPageContextIdentityKey,
  browserTabIdentityKey,
  browserUrlAllowedBySettings,
  createBrowserSessionActions,
  normalizeBrowserSessionActionIndex,
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

export const MAX_BROWSER_SESSION_APPROVAL_AGE_MS = 2 * 60 * 1000;

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
}

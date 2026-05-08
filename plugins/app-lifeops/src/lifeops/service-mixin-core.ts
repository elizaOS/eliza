import crypto from "node:crypto";
import { getAgentEventService } from "@elizaos/agent/runtime/agent-event-service";
import { resolveOwnerEntityId } from "@elizaos/agent/runtime/owner-entity";
import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  BROWSER_BRIDGE_COMPANION_CONNECTION_STATES,
  BROWSER_BRIDGE_KINDS,
  type BrowserBridgeAction,
  type BrowserBridgeCompanionStatus,
  type BrowserBridgeSettings,
  type UpsertBrowserBridgeCompanionRequest,
} from "@elizaos/plugin-browser";
import type {
  LifeOpsAuditEvent,
  LifeOpsAuditEventType,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsOwnership,
  LifeOpsOwnershipInput,
  LifeOpsWorkflowDefinition,
} from "../contracts/index.js";
import type { computeAdaptiveWindowPolicy } from "./defaults.js";
import {
  GoogleManagedClient,
  resolveManagedGoogleCloudConfig,
} from "./google-managed-client.js";
import {
  createBrowserBridgeCompanionStatus,
  createLifeOpsAuditEvent,
  LifeOpsRepository,
} from "./repository.js";
import { LifeOpsScheduleSyncClient } from "./schedule-sync-client.js";
import {
  DEFAULT_BROWSER_PERMISSION_STATE,
  DEFAULT_BROWSER_SETTINGS,
  reminderProcessingQueues,
} from "./service-constants.js";
import {
  defaultOwnerEntityId,
  fail,
  lifeOpsErrorMessage,
  normalizeEnumValue,
  normalizeLifeOpsContextPolicy,
  normalizeLifeOpsDomain,
  normalizeLifeOpsSubjectType,
  normalizeLifeOpsVisibilityScope,
  normalizeOptionalIsoString,
  normalizeOptionalString,
  requireAgentId,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  normalizeBrowserPermissionStateInput,
  normalizeOptionalConnectorMode,
} from "./service-normalize-connector.js";
import type { LifeOpsServiceOptions } from "./service-types.js";
import { XManagedClient } from "./x-managed-client.js";

// ---------------------------------------------------------------------------
// Mixin helper type
// ---------------------------------------------------------------------------

/** Constructor type for the mixin pattern. */
// biome-ignore lint/suspicious/noExplicitAny: mixin pattern requires open-ended constructor signature
export type Constructor<T = object> = new (...args: any[]) => T;

export type MixinClass<
  TBase extends Constructor,
  TPublic extends object,
> = new (
  ...args: ConstructorParameters<TBase>
) => InstanceType<TBase> & TPublic;

// ---------------------------------------------------------------------------
// Helpers used only inside the base class
// ---------------------------------------------------------------------------

function browserActionChangesState(
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

function mergeMetadata(
  current: Record<string, unknown>,
  updates?: Record<string, unknown>,
): Record<string, unknown> {
  const cloned =
    updates && typeof updates === "object" && !Array.isArray(updates)
      ? { ...updates }
      : {};
  const merged = {
    ...current,
    ...cloned,
  };
  if (
    typeof merged.privacyClass !== "string" ||
    merged.privacyClass.trim().length === 0
  ) {
    merged.privacyClass = "private";
  }
  if (merged.privacyClass === "private") {
    merged.publicContextBlocked = true;
  }
  return merged;
}

function googleGrantHasAuthFailureMetadata(
  metadata: Record<string, unknown>,
): boolean {
  return (
    metadata.authState !== undefined ||
    metadata.lastAuthError !== undefined ||
    metadata.lastAuthErrorAt !== undefined
  );
}

function clearGoogleGrantAuthFailureMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next.authState;
  delete next.lastAuthError;
  delete next.lastAuthErrorAt;
  return next;
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export class LifeOpsServiceBase {
  public readonly repository: LifeOpsRepository;
  public readonly explicitOwnerEntityIdValue: string | null;
  public readonly ownerEntityIdValue: string;
  public readonly googleManagedClient: GoogleManagedClient;
  public readonly xManagedClient: XManagedClient;
  public readonly scheduleSyncClient: LifeOpsScheduleSyncClient;
  public ownerRoutingEntityIdPromise: Promise<string | null> | null = null;

  /** Cached adaptive window policy derived from the activity profile.
   *  Recomputed at most every 30 minutes to avoid re-reading task metadata
   *  on every occurrence refresh. */
  public adaptiveWindowPolicyCache: {
    policy: ReturnType<typeof computeAdaptiveWindowPolicy>;
    computedAt: number;
  } | null = null;

  constructor(
    public readonly runtime: IAgentRuntime,
    options: LifeOpsServiceOptions = {},
  ) {
    this.repository = new LifeOpsRepository(runtime);
    const resolveManagedCloudConfig = () =>
      resolveManagedGoogleCloudConfig(runtime);
    this.googleManagedClient = new GoogleManagedClient(
      resolveManagedCloudConfig,
    );
    this.xManagedClient = new XManagedClient(resolveManagedCloudConfig);
    this.scheduleSyncClient = new LifeOpsScheduleSyncClient();
    this.explicitOwnerEntityIdValue =
      normalizeOptionalString(options.ownerEntityId) ?? null;
    this.ownerEntityIdValue =
      this.explicitOwnerEntityIdValue ?? defaultOwnerEntityId(runtime);
  }

  // -----------------------------------------------------------------------
  // Identity helpers
  // -----------------------------------------------------------------------

  public agentId(): string {
    return requireAgentId(this.runtime);
  }

  public ownerEntityId(): string {
    return this.ownerEntityIdValue;
  }

  public async ownerRoutingEntityId(): Promise<string | null> {
    if (this.explicitOwnerEntityIdValue) {
      return this.explicitOwnerEntityIdValue;
    }
    if (!this.ownerRoutingEntityIdPromise) {
      this.ownerRoutingEntityIdPromise = resolveOwnerEntityId(this.runtime);
    }
    return await this.ownerRoutingEntityIdPromise;
  }

  // -----------------------------------------------------------------------
  // Browser helpers
  // -----------------------------------------------------------------------

  public async getBrowserSettingsInternal(): Promise<BrowserBridgeSettings> {
    const current = await this.repository.getBrowserSettings(this.agentId());
    return current
      ? {
          ...current,
          grantedOrigins: [...current.grantedOrigins],
          blockedOrigins: [...current.blockedOrigins],
        }
      : {
          ...DEFAULT_BROWSER_SETTINGS,
          grantedOrigins: [...DEFAULT_BROWSER_SETTINGS.grantedOrigins],
          blockedOrigins: [...DEFAULT_BROWSER_SETTINGS.blockedOrigins],
          metadata: { ...DEFAULT_BROWSER_SETTINGS.metadata },
        };
  }

  public isBrowserPaused(settings: BrowserBridgeSettings): boolean {
    if (!settings.pauseUntil) {
      return false;
    }
    const pauseUntilMs = Date.parse(settings.pauseUntil);
    return Number.isFinite(pauseUntilMs) && pauseUntilMs > Date.now();
  }

  public async requireBrowserAvailableForActions(
    actions: readonly BrowserBridgeAction[],
  ): Promise<BrowserBridgeSettings> {
    const settings = await this.getBrowserSettingsInternal();
    if (!settings.enabled || settings.trackingMode === "off") {
      fail(
        409,
        "Agent Browser Bridge is disabled. Enable it in settings before starting browser sessions.",
      );
    }
    if (this.isBrowserPaused(settings)) {
      fail(409, "Agent Browser Bridge is paused.");
    }
    if (
      actions.some((action) => browserActionChangesState(action)) &&
      !settings.allowBrowserControl
    ) {
      fail(
        409,
        "Agent Browser Bridge control is disabled. Enable browser control in settings before running control actions.",
      );
    }
    return settings;
  }

  public buildBrowserCompanion(
    request: UpsertBrowserBridgeCompanionRequest,
    current: BrowserBridgeCompanionStatus | null,
  ): BrowserBridgeCompanionStatus {
    const browser = normalizeEnumValue(
      request.browser,
      "companion.browser",
      BROWSER_BRIDGE_KINDS,
    );
    const profileId = requireNonEmptyString(
      request.profileId,
      "companion.profileId",
    );
    const profileLabel =
      normalizeOptionalString(request.profileLabel) ??
      current?.profileLabel ??
      "";
    const extensionVersion =
      normalizeOptionalString(request.extensionVersion) ?? null;
    const connectionState =
      request.connectionState === undefined
        ? (current?.connectionState ?? "connected")
        : normalizeEnumValue(
            request.connectionState,
            "companion.connectionState",
            BROWSER_BRIDGE_COMPANION_CONNECTION_STATES,
          );
    const permissions = normalizeBrowserPermissionStateInput(
      request.permissions,
      current?.permissions ?? DEFAULT_BROWSER_PERMISSION_STATE,
    );
    const metadata = mergeMetadata(
      current?.metadata ?? {},
      normalizeOptionalRecord(request.metadata, "companion.metadata"),
    );
    const lastSeenAt =
      request.lastSeenAt === undefined
        ? (current?.lastSeenAt ?? new Date().toISOString())
        : (normalizeOptionalIsoString(
            request.lastSeenAt,
            "companion.lastSeenAt",
          ) ?? null);

    if (current) {
      return {
        ...current,
        browser,
        profileId,
        profileLabel,
        label: requireNonEmptyString(request.label, "companion.label"),
        extensionVersion,
        connectionState,
        permissions,
        lastSeenAt,
        metadata,
        updatedAt: new Date().toISOString(),
      };
    }

    return createBrowserBridgeCompanionStatus({
      agentId: this.agentId(),
      browser,
      profileId,
      profileLabel,
      label: requireNonEmptyString(request.label, "companion.label"),
      extensionVersion,
      connectionState,
      permissions,
      lastSeenAt,
      metadata,
    });
  }

  // -----------------------------------------------------------------------
  // Ownership helpers
  // -----------------------------------------------------------------------

  public normalizeOwnership(
    input: LifeOpsOwnershipInput | undefined,
    current?: LifeOpsOwnership,
  ): LifeOpsOwnership {
    const requestedDomain =
      input?.domain !== undefined ? input.domain : current?.domain;
    const domain = normalizeLifeOpsDomain(
      requestedDomain,
      current?.domain ?? "user_lifeops",
    );
    const requestedSubjectType =
      input?.subjectType !== undefined
        ? input.subjectType
        : current?.subjectType;
    const subjectType = normalizeLifeOpsSubjectType(
      requestedSubjectType,
      current?.subjectType ?? (domain === "agent_ops" ? "agent" : "owner"),
    );

    if (domain === "agent_ops" && subjectType !== "agent") {
      fail(
        400,
        "ownership.subjectType must be agent when ownership.domain is agent_ops",
      );
    }
    if (domain === "user_lifeops" && subjectType !== "owner") {
      fail(
        400,
        "ownership.subjectType must be owner when ownership.domain is user_lifeops",
      );
    }

    const expectedSubjectId =
      subjectType === "agent" ? this.agentId() : this.ownerEntityId();
    const requestedSubjectId =
      input?.subjectId !== undefined
        ? normalizeOptionalString(input.subjectId)
        : current?.subjectId;
    if (
      requestedSubjectId !== undefined &&
      requestedSubjectId !== null &&
      requestedSubjectId !== expectedSubjectId
    ) {
      fail(
        400,
        `ownership.subjectId must be ${expectedSubjectId} for ${subjectType} scope in v1`,
      );
    }

    const fallbackVisibility =
      subjectType === "agent" ? "agent_and_admin" : "owner_only";
    const fallbackContext = subjectType === "agent" ? "never" : "explicit_only";
    const visibilityScope =
      subjectType === "owner"
        ? "owner_only"
        : normalizeLifeOpsVisibilityScope(
            input?.visibilityScope ?? current?.visibilityScope,
            current?.visibilityScope ?? fallbackVisibility,
          );
    return {
      domain,
      subjectType,
      subjectId: expectedSubjectId,
      visibilityScope,
      contextPolicy: normalizeLifeOpsContextPolicy(
        input?.contextPolicy ?? current?.contextPolicy,
        current?.contextPolicy ?? fallbackContext,
      ),
    };
  }

  public normalizeChildOwnership(
    parent: LifeOpsOwnership,
    input: LifeOpsOwnershipInput | undefined,
    field = "ownership",
  ): LifeOpsOwnership {
    const normalized = this.normalizeOwnership(input, parent);
    if (
      normalized.domain !== parent.domain ||
      normalized.subjectType !== parent.subjectType ||
      normalized.subjectId !== parent.subjectId
    ) {
      fail(400, `${field} must match the parent workflow scope in v1`);
    }
    return normalized;
  }

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  public logLifeOpsWarn(
    operation: string,
    message: string,
    context: Record<string, unknown> = {},
  ): void {
    logger.warn(
      {
        boundary: "lifeops",
        operation,
        agentId: this.agentId(),
        ...context,
      },
      message,
    );
  }

  public logLifeOpsError(
    operation: string,
    error: unknown,
    context: Record<string, unknown> = {},
  ): void {
    logger.error(
      {
        boundary: "lifeops",
        operation,
        agentId: this.agentId(),
        err: error instanceof Error ? error : undefined,
        ...context,
      },
      `[lifeops] ${operation} failed: ${lifeOpsErrorMessage(error)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Reminder processing lock
  // -----------------------------------------------------------------------

  public async withReminderProcessingLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const agentId = this.agentId();
    const queueTail =
      reminderProcessingQueues.get(agentId) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const currentTurn = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const nextQueueTail = queueTail.then(() => currentTurn);
    reminderProcessingQueues.set(agentId, nextQueueTail);
    await queueTail;
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (reminderProcessingQueues.get(agentId) === nextQueueTail) {
        reminderProcessingQueues.delete(agentId);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Audit helpers
  // -----------------------------------------------------------------------

  public async recordAudit(
    eventType: LifeOpsAuditEventType,
    ownerType: "definition" | "occurrence" | "goal",
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType,
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  public async recordConnectorAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType: "connector_grant_updated",
        ownerType: "connector",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  public async recordChannelPolicyAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType: "channel_policy_updated",
        ownerType: "channel_policy",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  public async recordWorkflowAudit(
    eventType: "workflow_created" | "workflow_updated" | "workflow_run",
    ownerId: string,
    actor: "user" | "workflow" = "user",
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<LifeOpsAuditEvent> {
    const event = createLifeOpsAuditEvent({
      agentId: this.agentId(),
      eventType,
      ownerType: "workflow",
      ownerId,
      reason,
      inputs,
      decision,
      actor,
    });
    await this.repository.createAuditEvent(event);
    return event;
  }

  public async recordReminderAudit(
    eventType:
      | "reminder_due"
      | "reminder_delivered"
      | "reminder_blocked"
      | "reminder_escalation_started"
      | "reminder_escalation_resolved",
    ownerType: "occurrence" | "calendar_event",
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType,
        ownerId,
        reason,
        inputs,
        decision,
        actor: "workflow",
      }),
    );
  }

  public async recordBrowserAudit(
    eventType: "browser_session_created" | "browser_session_updated",
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType,
        ownerType: "browser_session",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  public async recordXPostAudit(
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.createAuditEvent(
      createLifeOpsAuditEvent({
        agentId: this.agentId(),
        eventType: "x_post_sent",
        ownerType: "connector",
        ownerId,
        reason,
        inputs,
        decision,
        actor: "user",
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Google grant auth helpers (shared with google mixin)
  // -----------------------------------------------------------------------

  public async clearGoogleGrantAuthFailure(
    grant: LifeOpsConnectorGrant,
  ): Promise<LifeOpsConnectorGrant> {
    if (!googleGrantHasAuthFailureMetadata(grant.metadata)) {
      return grant;
    }

    const nowIso = new Date().toISOString();
    const nextGrant: LifeOpsConnectorGrant = {
      ...grant,
      metadata: clearGoogleGrantAuthFailureMetadata(grant.metadata),
      lastRefreshAt: nowIso,
      updatedAt: nowIso,
    };
    await this.repository.upsertConnectorGrant(nextGrant);
    return nextGrant;
  }

  public async markGoogleGrantNeedsReauth(
    grant: LifeOpsConnectorGrant,
    message: string,
  ): Promise<LifeOpsConnectorGrant> {
    const nowIso = new Date().toISOString();
    const nextGrant: LifeOpsConnectorGrant = {
      ...grant,
      metadata: {
        ...grant.metadata,
        authState: "needs_reauth",
        lastAuthError: message,
        lastAuthErrorAt: nowIso,
      },
      updatedAt: nowIso,
    };
    await this.repository.upsertConnectorGrant(nextGrant);
    return nextGrant;
  }

  // -----------------------------------------------------------------------
  // Event helpers
  // -----------------------------------------------------------------------

  public emitAssistantEvent(
    text: string,
    source: string,
    data: Record<string, unknown> = {},
  ): void {
    const eventService = getAgentEventService(this.runtime) as {
      emit?: (event: {
        runId: string;
        stream: string;
        data: Record<string, unknown>;
        agentId?: string;
      }) => void;
    } | null;
    if (!eventService?.emit) {
      return;
    }
    eventService.emit({
      runId: crypto.randomUUID(),
      stream: "assistant",
      agentId: this.agentId(),
      data: {
        text,
        source,
        ...data,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Workflow helpers
  // -----------------------------------------------------------------------

  public async getWorkflowDefinition(
    workflowId: string,
  ): Promise<LifeOpsWorkflowDefinition> {
    const workflow = await this.repository.getWorkflow(
      this.agentId(),
      workflowId,
    );
    if (!workflow) {
      fail(404, "life-ops workflow not found");
    }
    return workflow;
  }

  // -----------------------------------------------------------------------
  // X grant helper
  // -----------------------------------------------------------------------

  public async requireXGrant(
    requestedMode?: LifeOpsConnectorMode,
  ): Promise<LifeOpsConnectorGrant> {
    const mode =
      normalizeOptionalConnectorMode(requestedMode, "mode") ?? "local";
    const grant = await this.repository.getConnectorGrant(
      this.agentId(),
      "x",
      mode,
    );
    if (!grant) {
      fail(409, "X is not connected.");
    }
    return grant;
  }
}

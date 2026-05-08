// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import type {
  CreateLifeOpsXPostRequest,
  DisconnectLifeOpsXConnectorRequest,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsXConnectorStatus,
  LifeOpsXDm,
  LifeOpsXPostResponse,
  StartLifeOpsXConnectorRequest,
  StartLifeOpsXConnectorResponse,
  UpsertLifeOpsXConnectorRequest,
} from "../contracts/index.js";
import { LIFEOPS_X_CAPABILITIES } from "../contracts/index.js";
import { createLifeOpsConnectorGrant } from "./repository.js";
import {
  createXDirectMessageGroupWithRuntimeService,
  createXPostWithRuntimeService,
  getXAccountStatusWithRuntimeService,
  sendXConversationMessageWithRuntimeService,
  sendXDirectMessageWithRuntimeService,
} from "./runtime-service-delegates.js";
import { normalizeOptionalRecord } from "./service-helpers-misc.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";

export interface LifeOpsXService {
  resolveXGrant(
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsConnectorGrant | null>;
  getXConnectorStatus(
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsXConnectorStatus>;
  startXConnector(
    request: StartLifeOpsXConnectorRequest,
  ): Promise<StartLifeOpsXConnectorResponse>;
  disconnectXConnector(
    request: DisconnectLifeOpsXConnectorRequest,
  ): Promise<LifeOpsXConnectorStatus>;
  upsertXConnector(
    request: UpsertLifeOpsXConnectorRequest,
  ): Promise<LifeOpsXConnectorStatus>;
  createXPost(
    request: CreateLifeOpsXPostRequest,
  ): Promise<LifeOpsXPostResponse>;
  getXDmDigest(opts?: { limit?: number; conversationId?: string }): Promise<{
    generatedAt: string;
    conversationId: string | null;
    unreadCount: number;
    readCount: number;
    repliedCount: number;
    recent: LifeOpsXDm[];
  }>;
  curateXDms(request: {
    messageIds?: string[];
    conversationId?: string;
    markRead?: boolean;
    markReplied?: boolean;
  }): Promise<{ curated: number }>;
  sendXDirectMessage(request: {
    participantId: string;
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
  }): Promise<{ ok: boolean; status: number | null; error?: string }>;
  sendXConversationMessage(request: {
    conversationId: string;
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
  }): Promise<{ ok: boolean; status: number | null; error?: string }>;
  createXDirectMessageGroup(request: {
    participantIds: string[];
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
  }): Promise<{
    ok: boolean;
    status: number | null;
    conversationId: string | null;
    error?: string;
  }>;
}

type LifeOpsXConnectorCapability =
  | "x.read"
  | "x.write"
  | "x.dm.read"
  | "x.dm.write";

function normalizeXCapabilityRequest(
  value: unknown,
): LifeOpsXConnectorCapability[] {
  const entries = Array.isArray(value) ? value : [];
  if (entries.length === 0) {
    fail(400, "capabilities must include at least one X capability");
  }
  const capabilities = entries.map((entry) =>
    normalizeEnumValue(entry, "capabilities", LIFEOPS_X_CAPABILITIES),
  );
  return [...new Set(capabilities)];
}

function createSyntheticXGrant(
  agentId: string,
  mode: LifeOpsConnectorMode,
  side: LifeOpsConnectorSide = "owner",
  capabilities: LifeOpsXConnectorCapability[] = [...LIFEOPS_X_CAPABILITIES],
): LifeOpsConnectorGrant {
  return createLifeOpsConnectorGrant({
    agentId,
    provider: "x",
    side,
    identity: {},
    grantedScopes: [],
    capabilities,
    tokenRef: null,
    mode,
    metadata: { source: "plugin-x-runtime" },
    lastRefreshAt: new Date().toISOString(),
  });
}

function resolveXCapabilities(
  capabilities: readonly string[] | undefined,
  hasCredentials: boolean,
): LifeOpsXConnectorCapability[] {
  if (capabilities && capabilities.length > 0) {
    return capabilities.filter(
      (capability): capability is LifeOpsXConnectorCapability =>
        LIFEOPS_X_CAPABILITIES.includes(
          capability as LifeOpsXConnectorCapability,
        ),
    );
  }
  return hasCredentials ? [...LIFEOPS_X_CAPABILITIES] : [];
}

function capabilitySummary(capabilities: readonly string[]) {
  const set = new Set(capabilities);
  return {
    feedRead: set.has("x.read"),
    feedWrite: set.has("x.write"),
    dmRead: set.has("x.dm.read"),
    dmWrite: set.has("x.dm.write"),
  };
}

function xCapabilitiesForSide(
  side: LifeOpsConnectorSide,
): LifeOpsXConnectorCapability[] {
  if (side === "agent") {
    return [...LIFEOPS_X_CAPABILITIES];
  }
  return ["x.read", "x.dm.read", "x.dm.write"];
}

function constrainXCapabilities(
  requested: readonly LifeOpsXConnectorCapability[],
  available: readonly LifeOpsXConnectorCapability[],
): LifeOpsXConnectorCapability[] {
  const availableSet = new Set(available);
  return requested.filter((capability) => availableSet.has(capability));
}

function xDefaultMode(): LifeOpsConnectorMode {
  return "local";
}

function xAvailableModes(): LifeOpsConnectorMode[] {
  return ["local"];
}

function xRuntimeAvailableCapabilities(
  side: LifeOpsConnectorSide,
  runtimeCapabilities: readonly string[] | undefined,
): LifeOpsXConnectorCapability[] {
  const sideCapabilities = xCapabilitiesForSide(side);
  const normalizedRuntimeCapabilities = resolveXCapabilities(
    runtimeCapabilities,
    Boolean(runtimeCapabilities?.length),
  );
  return constrainXCapabilities(normalizedRuntimeCapabilities, sideCapabilities);
}

function xDelegationFailureStatus(reason: string): number {
  return reason.includes("not registered") ? 409 : 502;
}

export function withX<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsXService> {
  return class extends Base {
    async resolveXGrant(
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsConnectorGrant | null> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const defaultMode = xDefaultMode();
      const mode =
        normalizeOptionalConnectorMode(requestedMode, "mode") ?? defaultMode;
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "x",
        mode,
        side,
      );
      if (grant) {
        return grant;
      }
      if (mode === "local") {
        const runtimeStatus = await getXAccountStatusWithRuntimeService({
          runtime: this.runtime,
          accountId: "default",
        });
        const localCapabilities =
          runtimeStatus.status === "handled" && runtimeStatus.value.connected
            ? xRuntimeAvailableCapabilities(
                side,
                runtimeStatus.value.grantedCapabilities,
              )
            : [];
        if (localCapabilities.length === 0) {
          return null;
        }
        return createSyntheticXGrant(
          this.agentId(),
          mode,
          side,
          localCapabilities,
        );
      }
      return null;
    }

    async getXConnectorStatus(
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsXConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const defaultMode = xDefaultMode();
      const mode =
        normalizeOptionalConnectorMode(requestedMode, "mode") ?? defaultMode;
      const availableModes = xAvailableModes();
      const storedGrant = await this.repository.getConnectorGrant(
        this.agentId(),
        "x",
        mode,
        side,
      );
      const runtimeStatus = await getXAccountStatusWithRuntimeService({
        runtime: this.runtime,
        grant: storedGrant,
      });
      const runtimeConnected =
        runtimeStatus.status === "handled" && runtimeStatus.value.connected;
      const availableCapabilities =
        runtimeStatus.status === "handled" && runtimeConnected
          ? xRuntimeAvailableCapabilities(
              side,
              runtimeStatus.value.grantedCapabilities,
            )
          : [];
      const syntheticGrant =
        mode === "local" && !storedGrant && availableCapabilities.length > 0
          ? createSyntheticXGrant(
              this.agentId(),
              mode,
              side,
              availableCapabilities,
            )
          : null;
      const grant = storedGrant ?? syntheticGrant;
      const capabilities = constrainXCapabilities(
        resolveXCapabilities(grant?.capabilities, runtimeConnected),
        availableCapabilities,
      );
      const capabilityFlags = capabilitySummary(capabilities);
      return {
        provider: "x",
        side,
        mode,
        defaultMode,
        availableModes,
        executionTarget: "local",
        sourceOfTruth: "local_storage",
        configured:
          runtimeStatus.status === "handled"
            ? runtimeStatus.value.configured
            : false,
        connected: runtimeConnected && Boolean(grant),
        reason:
          runtimeStatus.status === "handled"
            ? (runtimeStatus.value.reason as LifeOpsXConnectorStatus["reason"])
            : "config_missing",
        preferredByAgent: grant?.preferredByAgent ?? false,
        cloudConnectionId: grant?.cloudConnectionId ?? null,
        grantedCapabilities: capabilities,
        grantedScopes:
          grant?.grantedScopes ??
          (runtimeStatus.status === "handled"
            ? runtimeStatus.value.grantedScopes
            : []),
        identity:
          grant && Object.keys(grant.identity).length > 0
            ? grant.identity
            : runtimeStatus.status === "handled"
              ? runtimeStatus.value.identity
              : null,
        hasCredentials: runtimeConnected,
        ...capabilityFlags,
        dmInbound: capabilityFlags.dmRead,
        grant,
      };
    }

    async startXConnector(
      request: StartLifeOpsXConnectorRequest,
    ): Promise<StartLifeOpsXConnectorResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      if (mode === "cloud_managed") {
        fail(
          501,
          "Cloud-managed X connection is no longer handled by LifeOps. Configure plugin-x instead.",
        );
      }
      const runtimeStatus = await getXAccountStatusWithRuntimeService({
        runtime: this.runtime,
      });
      const capabilities =
        runtimeStatus.status === "handled" && runtimeStatus.value.connected
          ? xRuntimeAvailableCapabilities(
              side,
              runtimeStatus.value.grantedCapabilities,
            )
          : [];
      if (capabilities.length === 0) {
        fail(
          xDelegationFailureStatus(
            runtimeStatus.status === "fallback"
              ? runtimeStatus.reason
              : "X runtime service is not connected.",
          ),
          runtimeStatus.status === "fallback"
            ? runtimeStatus.reason
            : "X runtime service is not connected.",
        );
      }
      const status = await this.upsertXConnector({
        side,
        mode: "local",
        capabilities,
        grantedScopes: [],
        identity: {},
        metadata: { source: "plugin-x-runtime" },
      });
      return {
        provider: "x",
        side,
        mode: status.mode,
        requestedCapabilities: status.grantedCapabilities,
        redirectUri: "",
        authUrl: "",
      };
    }

    async disconnectXConnector(
      request: DisconnectLifeOpsXConnectorRequest = {},
    ): Promise<LifeOpsXConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      await this.repository.deleteConnectorGrant(
        this.agentId(),
        "x",
        mode,
        side,
      );
      return this.getXConnectorStatus(mode, side);
    }

    async upsertXConnector(
      request: UpsertLifeOpsXConnectorRequest,
    ): Promise<LifeOpsXConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? "local";
      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "x",
        mode,
        side,
      );
      const capabilities = normalizeXCapabilityRequest(request.capabilities);
      const scopes = Array.isArray(request.grantedScopes)
        ? request.grantedScopes.map((scope, index) =>
            requireNonEmptyString(scope, `grantedScopes[${index}]`),
          )
        : [];
      const identity =
        normalizeOptionalRecord(request.identity, "identity") ?? {};
      const metadata =
        normalizeOptionalRecord(request.metadata, "metadata") ?? {};
      const grant = existing
        ? {
            ...existing,
            identity,
            grantedScopes: scopes,
            capabilities,
            metadata: {
              ...existing.metadata,
              ...metadata,
            },
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "x",
            side,
            identity,
            grantedScopes: scopes,
            capabilities,
            tokenRef: null,
            mode,
            metadata,
            lastRefreshAt: new Date().toISOString(),
          });
      await this.repository.upsertConnectorGrant(grant);
      await this.recordConnectorAudit(
        `x:${mode}`,
        "x connector updated",
        { request },
        {
          capabilities,
        },
      );
      return this.getXConnectorStatus(mode, side);
    }

    async getXDmDigest(
      opts: { limit?: number; conversationId?: string } = {},
    ): Promise<{
      generatedAt: string;
      conversationId: string | null;
      unreadCount: number;
      readCount: number;
      repliedCount: number;
      recent: LifeOpsXDm[];
    }> {
      const grant = await this.resolveXGrant();
      if (!grant) {
        fail(409, "X is not connected.");
      }
      if (typeof this.syncXDms === "function") {
        await this.syncXDms({ limit: opts.limit });
      }
      const dms = await this.repository.listXDms(this.agentId(), {
        conversationId: opts.conversationId,
        limit: opts.limit ?? 25,
      });
      const unread = dms.filter((dm) => dm.isInbound && dm.readAt === null);
      const read = dms.filter((dm) => dm.readAt !== null);
      const replied = dms.filter((dm) => dm.repliedAt !== null);
      return {
        generatedAt: new Date().toISOString(),
        conversationId: opts.conversationId ?? null,
        unreadCount: unread.length,
        readCount: read.length,
        repliedCount: replied.length,
        recent: dms,
      };
    }

    async curateXDms(request: {
      messageIds?: string[];
      conversationId?: string;
      markRead?: boolean;
      markReplied?: boolean;
    }): Promise<{ curated: number }> {
      const grant = await this.resolveXGrant();
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const now = new Date().toISOString();
      const messages = await this.repository.listXDms(this.agentId(), {
        conversationId: request.conversationId,
        limit: Math.max(request.messageIds?.length ?? 0, 25),
      });
      const ids = new Set(request.messageIds ?? []);
      let curated = 0;
      for (const dm of messages) {
        if (ids.size > 0 && !ids.has(dm.id)) {
          continue;
        }
        const next = {
          ...dm,
          readAt: request.markRead ? (dm.readAt ?? now) : dm.readAt,
          repliedAt: request.markReplied ? (dm.repliedAt ?? now) : dm.repliedAt,
          updatedAt: now,
        };
        if (
          next.readAt !== dm.readAt ||
          next.repliedAt !== dm.repliedAt ||
          next.updatedAt !== dm.updatedAt
        ) {
          await this.repository.upsertXDm(next);
          curated += 1;
        }
      }
      return { curated };
    }

    async sendXDirectMessage(request: {
      participantId: string;
      text: string;
      confirmSend?: boolean;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
    }): Promise<{ ok: boolean; status: number | null; error?: string }> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      const grant = await this.resolveXGrant(mode, side);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const capabilities = new Set(resolveXCapabilities(grant.capabilities, true));
      if (!capabilities.has("x.dm.write")) {
        fail(403, "X DM write access has not been granted.");
      }
      const participantId = normalizeOptionalString(
        request.participantId,
      )?.trim();
      const text = normalizeOptionalString(request.text)?.trim();
      if (!participantId) {
        fail(400, "participantId is required");
      }
      if (!text) {
        fail(400, "text is required");
      }
      if (request.confirmSend !== true) {
        fail(409, "X DM sending requires explicit confirmation.");
      }
      const delegated = await sendXDirectMessageWithRuntimeService({
        runtime: this.runtime,
        grant,
        participantId,
        text,
      });
      if (delegated.status === "handled") {
        return { ok: true, status: delegated.value.status ?? 201 };
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
          delegated.reason,
          {
            provider: "x",
            operation: "dm.send",
            grantId: grant.id,
            accountId: null,
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }
      fail(xDelegationFailureStatus(delegated.reason), delegated.reason);
    }

    async sendXConversationMessage(request: {
      conversationId: string;
      text: string;
      confirmSend?: boolean;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
    }): Promise<{ ok: boolean; status: number | null; error?: string }> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      const grant = await this.resolveXGrant(mode, side);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const capabilities = new Set(
        resolveXCapabilities(grant.capabilities, true),
      );
      if (!capabilities.has("x.dm.write")) {
        fail(403, "X DM write access has not been granted.");
      }
      const conversationId = normalizeOptionalString(
        request.conversationId,
      )?.trim();
      const text = normalizeOptionalString(request.text)?.trim();
      if (!conversationId) {
        fail(400, "conversationId is required");
      }
      if (!text) {
        fail(400, "text is required");
      }
      if (request.confirmSend !== true) {
        fail(409, "X DM sending requires explicit confirmation.");
      }
      const delegated = await sendXConversationMessageWithRuntimeService({
        runtime: this.runtime,
        grant,
        conversationId,
        text,
      });
      if (delegated.status === "handled") {
        return { ok: true, status: delegated.value.status ?? 201 };
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
          delegated.reason,
          {
            provider: "x",
            operation: "dm.conversation.send",
            grantId: grant.id,
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }
      fail(xDelegationFailureStatus(delegated.reason), delegated.reason);
    }

    async createXDirectMessageGroup(request: {
      participantIds: string[];
      text: string;
      confirmSend?: boolean;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
    }): Promise<{
      ok: boolean;
      status: number | null;
      conversationId: string | null;
      error?: string;
    }> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      const grant = await this.resolveXGrant(mode, side);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const capabilities = new Set(
        resolveXCapabilities(grant.capabilities, true),
      );
      if (!capabilities.has("x.dm.write")) {
        fail(403, "X DM write access has not been granted.");
      }
      const participantIds = Array.isArray(request.participantIds)
        ? request.participantIds.map((participantId, index) =>
            requireNonEmptyString(participantId, `participantIds[${index}]`),
          )
        : [];
      const uniqueParticipantIds = [...new Set(participantIds)];
      if (uniqueParticipantIds.length < 2) {
        fail(
          400,
          "At least two participant IDs are required to create an X group DM.",
        );
      }
      const text = normalizeOptionalString(request.text)?.trim();
      if (!text) {
        fail(400, "text is required");
      }
      if (request.confirmSend !== true) {
        fail(409, "X group DM creation requires explicit confirmation.");
      }
      const delegated = await createXDirectMessageGroupWithRuntimeService({
        runtime: this.runtime,
        grant,
        participantIds: uniqueParticipantIds,
        text,
      });
      if (delegated.status === "handled") {
        return {
          ok: true,
          status: delegated.value.status ?? 201,
          conversationId: delegated.value.conversationId,
        };
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
          delegated.reason,
          {
            provider: "x",
            operation: "dm.group.create",
            grantId: grant.id,
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }
      fail(xDelegationFailureStatus(delegated.reason), delegated.reason);
    }

    async createXPost(
      request: CreateLifeOpsXPostRequest,
    ): Promise<LifeOpsXPostResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      const grant = await this.resolveXGrant(mode, side);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const capabilities = new Set(resolveXCapabilities(grant.capabilities, true));
      if (!capabilities.has("x.write")) {
        fail(403, "X write access has not been granted.");
      }
      const text = requireNonEmptyString(request.text, "text");
      const policy = await this.resolvePrimaryChannelPolicy("x");
      const trustedPosting =
        Boolean(policy?.allowPosts) &&
        policy?.requireConfirmationForActions === false;
      const confirmPost =
        normalizeOptionalBoolean(request.confirmPost, "confirmPost") ?? false;
      if (!confirmPost && !trustedPosting) {
        fail(
          409,
          "X posting requires explicit confirmation or a trusted posting policy.",
        );
      }
      const delegated = await createXPostWithRuntimeService({
        runtime: this.runtime,
        grant,
        text,
      });
      if (delegated.status !== "handled") {
        this.logLifeOpsWarn(
          "x_post",
          delegated.reason,
          {
            mode: grant.mode,
            statusCode: xDelegationFailureStatus(delegated.reason),
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : delegated.error
                  ? String(delegated.error)
                  : undefined,
          },
        );
        fail(xDelegationFailureStatus(delegated.reason), delegated.reason);
      }
      const metadata = delegated.value.metadata as
        | Record<string, unknown>
        | undefined;
      const postId =
        typeof metadata?.messageIdFull === "string"
          ? metadata.messageIdFull
          : typeof (metadata?.x as Record<string, unknown> | undefined)
                ?.tweetId === "string"
            ? ((metadata?.x as Record<string, unknown>).tweetId as string)
            : delegated.value.id;
      await this.recordXPostAudit(
        `x:${grant.mode}`,
        "x post sent",
        {
          text,
          confirmPost,
          trustedPosting,
        },
        {
          postId: postId ?? null,
          status: delegated.value.createdAt ? 201 : null,
        },
      );
      return {
        ok: true,
        status: 201,
        postId,
        category: "success",
      };
    }
  } as MixinClass<TBase, LifeOpsXService>;
}

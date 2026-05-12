import crypto from "node:crypto";
import type {
  CreateLifeOpsXPostRequest,
  DisconnectLifeOpsXConnectorRequest,
  LifeOpsChannelPolicy,
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
  fetchXDirectMessagesWithRuntimeService,
  getXAccountStatusWithRuntimeService,
  resolveRuntimeConnectorAccountId,
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
    requestedAccountId?: string | null,
  ): Promise<LifeOpsConnectorGrant | null>;
  getXConnectorStatus(
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    requestedAccountId?: string | null,
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
  getXDmDigest(opts?: {
    accountId?: string;
    limit?: number;
    conversationId?: string;
  }): Promise<{
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
    accountId?: string;
  }): Promise<{ ok: boolean; status: number | null; error?: string }>;
  sendXConversationMessage(request: {
    conversationId: string;
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    accountId?: string;
  }): Promise<{ ok: boolean; status: number | null; error?: string }>;
  createXDirectMessageGroup(request: {
    participantIds: string[];
    text: string;
    confirmSend?: boolean;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    accountId?: string;
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

type XMixinDependencies = LifeOpsServiceBase & {
  resolvePrimaryChannelPolicy(
    channelType: LifeOpsChannelPolicy["channelType"],
  ): Promise<LifeOpsChannelPolicy | null>;
};

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
  accountId?: string | null,
): LifeOpsConnectorGrant {
  return createLifeOpsConnectorGrant({
    agentId,
    provider: "x",
    connectorAccountId: accountId ?? undefined,
    side,
    identity: {},
    grantedScopes: [],
    capabilities,
    tokenRef: null,
    mode,
    metadata: {
      source: "plugin-x-runtime",
      ...(accountId
        ? { accountId, connectorAccountId: accountId }
        : {}),
    },
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

function xDelegationFailureStatus(reason: string): number {
  return reason.includes("not registered") ? 409 : 502;
}

function normalizeXReason(
  value: unknown,
): NonNullable<LifeOpsXConnectorStatus["reason"]> {
  return value === "connected" ||
    value === "needs_reauth" ||
    value === "config_missing"
    ? value
    : "disconnected";
}

function xRequestedAccountId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return (
    normalizeOptionalString(record.accountId) ??
    normalizeOptionalString(record.connectorAccountId)
  );
}

function xGrantRuntimeAccountId(
  grant: LifeOpsConnectorGrant | null | undefined,
  requestedAccountId?: string | null,
): string {
  return resolveRuntimeConnectorAccountId({
    accountId: requestedAccountId,
    grant,
  });
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
  return constrainXCapabilities(
    normalizedRuntimeCapabilities,
    sideCapabilities,
  );
}

export function withX<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsXService> {
  const XBase = Base as unknown as Constructor<XMixinDependencies>;

  class LifeOpsXServiceMixin extends XBase {
    async resolveXGrant(
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      requestedAccountId?: string | null,
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
          accountId: requestedAccountId,
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
          runtimeStatus.status === "handled"
            ? runtimeStatus.value.accountId
            : requestedAccountId,
        );
      }
      return null;
    }

    async getXConnectorStatus(
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
      requestedAccountId?: string | null,
    ): Promise<LifeOpsXConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const defaultMode = xDefaultMode();
      const mode =
        normalizeOptionalConnectorMode(requestedMode, "mode") ?? defaultMode;
      const availableModes = xAvailableModes();
      const grant = await this.resolveXGrant(mode, side, requestedAccountId);
      const accountId = xGrantRuntimeAccountId(grant, requestedAccountId);
      const runtimeStatus = await getXAccountStatusWithRuntimeService({
        runtime: this.runtime,
        grant,
        accountId,
      });
      const runtimeConnected =
        runtimeStatus.status === "handled" && runtimeStatus.value.connected;
      const availableLocalCapabilities =
        runtimeStatus.status === "handled"
          ? xRuntimeAvailableCapabilities(
              side,
              runtimeStatus.value.grantedCapabilities,
            )
          : [];
      const capabilities = constrainXCapabilities(
        resolveXCapabilities(grant?.capabilities, runtimeConnected),
        availableLocalCapabilities,
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
        configured: runtimeStatus.status === "handled",
        connected: runtimeConnected,
        reason: normalizeXReason(
          runtimeStatus.status === "handled"
            ? runtimeStatus.value.reason
            : runtimeStatus.reason,
        ),
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
      const requestedAccountId = xRequestedAccountId(request);
      const runtimeStatus = await getXAccountStatusWithRuntimeService({
        runtime: this.runtime,
        accountId: requestedAccountId,
      });
      const accountId =
        runtimeStatus.status === "handled"
          ? runtimeStatus.value.accountId
          : requestedAccountId;
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
            runtimeStatus.status === "handled"
              ? runtimeStatus.value.reason
              : runtimeStatus.reason,
          ),
          "X plugin runtime service is not connected.",
        );
      }
      const status = await this.upsertXConnector({
        side,
        mode: "local",
        capabilities,
        grantedScopes:
          runtimeStatus.status === "handled"
            ? runtimeStatus.value.grantedScopes
            : [],
        identity:
          runtimeStatus.status === "handled"
            ? (runtimeStatus.value.identity ?? {})
            : {},
        metadata: {
          source: "plugin-x-runtime",
          ...(accountId
            ? { accountId, connectorAccountId: accountId }
            : {}),
        },
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
      return this.getXConnectorStatus(mode, side, xRequestedAccountId(request));
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
      const requestedAccountId =
        xRequestedAccountId(request) ?? xRequestedAccountId(metadata);
      const grantMetadata = {
        ...metadata,
        ...(requestedAccountId
          ? {
              accountId: requestedAccountId,
              connectorAccountId: requestedAccountId,
            }
          : {}),
      };
      const grant = existing
        ? {
            ...existing,
            connectorAccountId:
              requestedAccountId ?? existing.connectorAccountId,
            identity,
            grantedScopes: scopes,
            capabilities,
            metadata: {
              ...existing.metadata,
              ...grantMetadata,
            },
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "x",
            connectorAccountId: requestedAccountId ?? undefined,
            side,
            identity,
            grantedScopes: scopes,
            capabilities,
            tokenRef: null,
            mode,
            metadata: grantMetadata,
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
      return this.getXConnectorStatus(mode, side, requestedAccountId);
    }

    async getXDmDigest(
      opts: { accountId?: string; limit?: number; conversationId?: string } = {},
    ): Promise<{
      generatedAt: string;
      conversationId: string | null;
      unreadCount: number;
      readCount: number;
      repliedCount: number;
      recent: LifeOpsXDm[];
    }> {
      const requestedAccountId = xRequestedAccountId(opts);
      const grant = await this.resolveXGrant(
        undefined,
        undefined,
        requestedAccountId,
      );
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const accountId = xGrantRuntimeAccountId(grant, requestedAccountId);
      const delegated = await fetchXDirectMessagesWithRuntimeService({
        runtime: this.runtime,
        grant,
        accountId,
        limit: opts.limit,
      });
      if (delegated.status === "handled") {
        const syncedAt = new Date().toISOString();
        for (const memory of delegated.value) {
          const metadata =
            memory.metadata && typeof memory.metadata === "object"
              ? (memory.metadata as Record<string, unknown>)
              : {};
          const x =
            metadata.x && typeof metadata.x === "object"
              ? (metadata.x as Record<string, unknown>)
              : {};
          const sender =
            metadata.sender && typeof metadata.sender === "object"
              ? (metadata.sender as Record<string, unknown>)
              : {};
          const externalDmId =
            typeof x.dmEventId === "string"
              ? x.dmEventId
              : typeof metadata.messageIdFull === "string"
                ? metadata.messageIdFull
                : String(memory.id ?? crypto.randomUUID());
          const senderId =
            typeof x.senderId === "string"
              ? x.senderId
              : typeof sender.id === "string"
                ? sender.id
                : String(memory.entityId ?? "unknown");
          const conversationId =
            typeof x.conversationId === "string"
              ? x.conversationId
              : String(memory.roomId ?? `dm:${senderId}`);
          await this.repository.upsertXDm({
            id: `${this.agentId()}:x:${externalDmId}`,
            agentId: this.agentId(),
            externalDmId,
            conversationId,
            senderHandle:
              typeof x.senderUsername === "string"
                ? x.senderUsername
                : typeof sender.username === "string"
                  ? sender.username
                  : "",
            senderId,
            isInbound:
              typeof x.isInbound === "boolean"
                ? x.isInbound
                : metadata.fromBot === true
                  ? false
                  : true,
            text: memory.content?.text ?? "",
            receivedAt:
              Number.isFinite(Number(memory.createdAt)) &&
              Number(memory.createdAt) > 0
                ? new Date(Number(memory.createdAt)).toISOString()
                : syncedAt,
            readAt: null,
            repliedAt: null,
            metadata: {
              ...metadata,
              source: "plugin-x-runtime",
            },
            syncedAt,
            updatedAt: syncedAt,
          });
        }
      } else {
        const cached = await this.repository.listXDms(this.agentId(), {
          conversationId: opts.conversationId,
          limit: opts.limit ?? 25,
        });
        if (cached.length === 0) {
          fail(
            xDelegationFailureStatus(delegated.reason),
            delegated.error instanceof Error
              ? delegated.error.message
              : delegated.reason,
          );
        }
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
      accountId?: string;
    }): Promise<{ ok: boolean; status: number | null; error?: string }> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      const requestedAccountId = xRequestedAccountId(request);
      const grant = await this.resolveXGrant(mode, side, requestedAccountId);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const accountId = xGrantRuntimeAccountId(grant, requestedAccountId);
      const capabilities = new Set(
        resolveXCapabilities(grant.capabilities, true),
      );
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
      const result = await sendXDirectMessageWithRuntimeService({
        runtime: this.runtime,
        grant,
        accountId,
        participantId,
        text,
      });
      if (result.status !== "handled") {
        fail(
          xDelegationFailureStatus(result.reason),
          result.error instanceof Error ? result.error.message : result.reason,
        );
      }
      return {
        ok: result.value.ok === true,
        status: result.value.status ?? 201,
      };
    }

    async sendXConversationMessage(request: {
      conversationId: string;
      text: string;
      confirmSend?: boolean;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      accountId?: string;
    }): Promise<{ ok: boolean; status: number | null; error?: string }> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      const requestedAccountId = xRequestedAccountId(request);
      const grant = await this.resolveXGrant(mode, side, requestedAccountId);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const accountId = xGrantRuntimeAccountId(grant, requestedAccountId);
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
      const result = await sendXConversationMessageWithRuntimeService({
        runtime: this.runtime,
        grant,
        accountId,
        conversationId,
        text,
      });
      if (result.status !== "handled") {
        fail(
          xDelegationFailureStatus(result.reason),
          result.error instanceof Error ? result.error.message : result.reason,
        );
      }
      return {
        ok: result.value.ok === true,
        status: result.value.status ?? 201,
      };
    }

    async createXDirectMessageGroup(request: {
      participantIds: string[];
      text: string;
      confirmSend?: boolean;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      accountId?: string;
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
      const requestedAccountId = xRequestedAccountId(request);
      const grant = await this.resolveXGrant(mode, side, requestedAccountId);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const accountId = xGrantRuntimeAccountId(grant, requestedAccountId);
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
      const result = await createXDirectMessageGroupWithRuntimeService({
        runtime: this.runtime,
        grant,
        accountId,
        participantIds: uniqueParticipantIds,
        text,
      });
      if (result.status !== "handled") {
        fail(
          xDelegationFailureStatus(result.reason),
          result.error instanceof Error ? result.error.message : result.reason,
        );
      }
      return {
        ok: result.value.ok === true,
        status: result.value.status ?? 201,
        conversationId: result.value.conversationId ?? null,
      };
    }

    async createXPost(
      request: CreateLifeOpsXPostRequest,
    ): Promise<LifeOpsXPostResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? xDefaultMode();
      const requestedAccountId = xRequestedAccountId(request);
      const grant = await this.resolveXGrant(mode, side, requestedAccountId);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const accountId = xGrantRuntimeAccountId(grant, requestedAccountId);
      const capabilities = new Set(
        resolveXCapabilities(grant.capabilities, true),
      );
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
      const result = await createXPostWithRuntimeService({
        runtime: this.runtime,
        grant,
        accountId,
        text,
      });
      if (result.status !== "handled") {
        fail(
          xDelegationFailureStatus(result.reason),
          result.error instanceof Error ? result.error.message : result.reason,
        );
      }
      const metadata = result.value.metadata as
        | Record<string, unknown>
        | undefined;
      const postId =
        typeof metadata?.messageIdFull === "string"
          ? metadata.messageIdFull
          : typeof (metadata?.x as Record<string, unknown> | undefined)
                ?.tweetId === "string"
            ? ((metadata?.x as Record<string, unknown>).tweetId as string)
            : result.value.id;
      await this.recordXPostAudit(
        `x:${grant.mode}`,
        "x post sent",
        {
          text,
          confirmPost,
          trustedPosting,
        },
        {
          postId,
          status: 201,
        },
      );
      return {
        ok: true,
        status: 201,
        postId,
        category: "success",
      };
    }
  }

  return LifeOpsXServiceMixin as unknown as MixinClass<TBase, LifeOpsXService>;
}

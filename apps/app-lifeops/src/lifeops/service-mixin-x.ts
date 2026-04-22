// @ts-nocheck — mixin: type safety is enforced on the composed class
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
} from "@elizaos/app-lifeops/contracts";
import { LIFEOPS_X_CAPABILITIES } from "@elizaos/app-lifeops/contracts";
import { createLifeOpsConnectorGrant } from "./repository.js";
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
import {
  ManagedXClientError,
  type ManagedXConnectorStatusResponse,
} from "./x-managed-client.js";
import { postToX, readXPosterCredentialsFromEnv, sendXDm } from "./x-poster.js";

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
    metadata: { source: "env" },
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

function hasLocalXReadIdentity(): boolean {
  return (process.env.TWITTER_USER_ID ?? "").trim().length > 0;
}

function localXAvailableCapabilities(
  side: LifeOpsConnectorSide,
): LifeOpsXConnectorCapability[] {
  if (!readXPosterCredentialsFromEnv()) {
    return [];
  }
  const canRead = hasLocalXReadIdentity();
  return xCapabilitiesForSide(side).filter((capability) => {
    if (capability === "x.read" || capability === "x.dm.read") {
      return canRead;
    }
    return true;
  });
}

function constrainXCapabilities(
  requested: readonly LifeOpsXConnectorCapability[],
  available: readonly LifeOpsXConnectorCapability[],
): LifeOpsXConnectorCapability[] {
  const availableSet = new Set(available);
  return requested.filter((capability) => availableSet.has(capability));
}

function xDefaultMode(cloudConfigured: boolean): LifeOpsConnectorMode {
  return cloudConfigured ? "cloud_managed" : "local";
}

function xAvailableModes(cloudConfigured: boolean): LifeOpsConnectorMode[] {
  return cloudConfigured ? ["cloud_managed", "local"] : ["local"];
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
      const defaultMode = xDefaultMode(this.xManagedClient.configured);
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
      const localCapabilities = localXAvailableCapabilities(side);
      if (mode === "local" && localCapabilities.length > 0) {
        return createSyntheticXGrant(
          this.agentId(),
          mode,
          side,
          localCapabilities,
        );
      }
      return null;
    }

    private async upsertManagedXGrant(
      status: ManagedXConnectorStatusResponse,
    ): Promise<LifeOpsConnectorGrant | null> {
      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "x",
        "cloud_managed",
        status.side,
      );
      if (!existing && !status.connected) {
        return null;
      }
      const nowIso = new Date().toISOString();
      const grant = existing
        ? {
            ...existing,
            identity: status.identity ? { ...status.identity } : {},
            grantedScopes: [...status.grantedScopes],
            capabilities: [...status.grantedCapabilities],
            mode: "cloud_managed" as const,
            executionTarget: "cloud" as const,
            sourceOfTruth: "cloud_connection" as const,
            cloudConnectionId: status.connectionId,
            metadata: {
              ...existing.metadata,
              linkedAt: status.linkedAt,
              lastUsedAt: status.lastUsedAt,
              authState:
                status.reason === "needs_reauth" ? "needs_reauth" : undefined,
            },
            lastRefreshAt: nowIso,
            updatedAt: nowIso,
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "x",
            side: status.side,
            identity: status.identity ? { ...status.identity } : {},
            grantedScopes: [...status.grantedScopes],
            capabilities: [...status.grantedCapabilities],
            tokenRef: null,
            mode: "cloud_managed",
            executionTarget: "cloud",
            sourceOfTruth: "cloud_connection",
            preferredByAgent: status.side === "owner",
            cloudConnectionId: status.connectionId,
            metadata: {
              linkedAt: status.linkedAt,
              lastUsedAt: status.lastUsedAt,
              authState:
                status.reason === "needs_reauth" ? "needs_reauth" : undefined,
            },
            lastRefreshAt: nowIso,
          });
      await this.repository.upsertConnectorGrant(grant);
      return grant;
    }

    async getXConnectorStatus(
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsXConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const cloudConfigured = this.xManagedClient.configured;
      const defaultMode = xDefaultMode(cloudConfigured);
      const mode =
        normalizeOptionalConnectorMode(requestedMode, "mode") ?? defaultMode;
      const availableModes = xAvailableModes(cloudConfigured);
      if (mode === "cloud_managed") {
        const localGrant = await this.repository.getConnectorGrant(
          this.agentId(),
          "x",
          "cloud_managed",
          side,
        );
        let managedStatus: ManagedXConnectorStatusResponse;
        try {
          managedStatus = await this.xManagedClient.getStatus(side);
        } catch (error) {
          if (error instanceof ManagedXClientError) {
            fail(error.status, error.message);
          }
          throw error;
        }
        const grant =
          (await this.upsertManagedXGrant(managedStatus)) ?? localGrant ?? null;
        const capabilities = resolveXCapabilities(
          grant?.capabilities ?? managedStatus.grantedCapabilities,
          managedStatus.connected,
        );
        const capabilityFlags = capabilitySummary(capabilities);
        return {
          provider: "x",
          side,
          mode,
          defaultMode,
          availableModes,
          executionTarget: "cloud",
          sourceOfTruth: "cloud_connection",
          configured: managedStatus.configured,
          connected: managedStatus.connected,
          reason: managedStatus.reason,
          preferredByAgent: grant?.preferredByAgent ?? false,
          cloudConnectionId: managedStatus.connectionId,
          grantedCapabilities: capabilities,
          grantedScopes: grant?.grantedScopes ?? managedStatus.grantedScopes,
          identity: managedStatus.identity,
          hasCredentials: managedStatus.connected,
          ...capabilityFlags,
          dmInbound: capabilityFlags.dmRead,
          grant,
        };
      }

      const grant = await this.resolveXGrant(mode, side);
      const localCredentials = readXPosterCredentialsFromEnv();
      const hasCredentials = Boolean(localCredentials);
      const availableLocalCapabilities = localXAvailableCapabilities(side);
      const capabilities = constrainXCapabilities(
        resolveXCapabilities(grant?.capabilities, hasCredentials),
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
        configured: hasCredentials,
        connected:
          mode === "cloud_managed"
            ? Boolean(grant?.cloudConnectionId ?? grant)
            : hasCredentials,
        reason: hasCredentials ? "connected" : "config_missing",
        preferredByAgent: grant?.preferredByAgent ?? false,
        cloudConnectionId: grant?.cloudConnectionId ?? null,
        grantedCapabilities: capabilities,
        grantedScopes: grant?.grantedScopes ?? [],
        identity:
          grant && Object.keys(grant.identity).length > 0
            ? grant.identity
            : hasLocalXReadIdentity()
              ? { userId: (process.env.TWITTER_USER_ID ?? "").trim() }
              : null,
        hasCredentials,
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
        normalizeOptionalConnectorMode(request.mode, "mode") ??
        xDefaultMode(this.xManagedClient.configured);
      if (mode === "cloud_managed") {
        return this.xManagedClient.startConnector({
          side,
          redirectUrl: normalizeOptionalString(request.redirectUrl),
        });
      }
      const capabilities = localXAvailableCapabilities(side);
      if (capabilities.length === 0) {
        fail(409, "X credentials are not configured.");
      }
      const status = await this.upsertXConnector({
        side,
        mode: "local",
        capabilities,
        grantedScopes: [],
        identity: {},
        metadata: { source: "local_env" },
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
        normalizeOptionalConnectorMode(request.mode, "mode") ??
        xDefaultMode(this.xManagedClient.configured);
      if (mode === "cloud_managed" && this.xManagedClient.configured) {
        await this.xManagedClient.disconnectConnector(side);
      }
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
      if (grant.mode === "cloud_managed") {
        const digest = await this.xManagedClient.getDmDigest({
          side: grant.side,
          maxResults: opts.limit,
        });
        const syncedAt = digest.syncedAt;
        for (const message of digest.messages) {
          await this.repository.upsertXDm({
            id: `${this.agentId()}:x:${message.id}`,
            agentId: this.agentId(),
            externalDmId: message.id,
            conversationId: message.conversationId,
            senderHandle: "",
            senderId: message.senderId,
            isInbound: message.direction === "received",
            text: message.text,
            receivedAt: message.createdAt ?? syncedAt,
            readAt: null,
            repliedAt: null,
            metadata: {
              participantId: message.participantId,
              participantIds: message.participantIds,
              recipientId: message.recipientId,
              entities: message.entities,
              hasAttachment: message.hasAttachment,
              source: "cloud",
            },
            syncedAt,
            updatedAt: syncedAt,
          });
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
    }): Promise<{ ok: boolean; status: number | null; error?: string }> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ??
        xDefaultMode(this.xManagedClient.configured);
      const grant = await this.resolveXGrant(mode, side);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const capabilities = new Set(
        resolveXCapabilities(
          grant.capabilities,
          mode === "cloud_managed" || Boolean(readXPosterCredentialsFromEnv()),
        ),
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
      if (mode === "cloud_managed") {
        const result = await this.xManagedClient.sendDm({
          side,
          participantId,
          text,
        });
        return { ok: result.sent, status: 201 };
      }
      const credentials = readXPosterCredentialsFromEnv();
      if (!credentials) {
        fail(409, "X credentials are not configured.");
      }
      const result = await sendXDm({
        participantId,
        text,
        credentials,
      });
      if (!result.ok) {
        fail(result.status ?? 502, result.error ?? "Failed to send X DM.");
      }
      return { ok: true, status: result.status };
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
        normalizeOptionalConnectorMode(request.mode, "mode") ??
        xDefaultMode(this.xManagedClient.configured);
      if (mode !== "cloud_managed") {
        fail(501, "X conversation replies require Eliza Cloud-managed X.");
      }
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
      const result = await this.xManagedClient.sendDmToConversation({
        side,
        conversationId,
        text,
      });
      return { ok: result.sent, status: 201 };
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
        normalizeOptionalConnectorMode(request.mode, "mode") ??
        xDefaultMode(this.xManagedClient.configured);
      if (mode !== "cloud_managed") {
        fail(501, "X group DMs require Eliza Cloud-managed X.");
      }
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
      const result = await this.xManagedClient.createDmGroup({
        side,
        participantIds: uniqueParticipantIds,
        text,
      });
      return {
        ok: result.sent,
        status: 201,
        conversationId:
          result.conversationId ?? result.message.conversationId ?? null,
      };
    }

    async createXPost(
      request: CreateLifeOpsXPostRequest,
    ): Promise<LifeOpsXPostResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ??
        xDefaultMode(this.xManagedClient.configured);
      const grant = await this.resolveXGrant(mode, side);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const capabilities = new Set(
        resolveXCapabilities(
          grant.capabilities,
          mode === "cloud_managed" || Boolean(readXPosterCredentialsFromEnv()),
        ),
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
      if (mode === "cloud_managed") {
        const result = await this.xManagedClient.createPost({
          side,
          text,
          confirmPost: true,
        });
        await this.recordXPostAudit(
          `x:${grant.mode}`,
          "x post sent",
          {
            text,
            confirmPost,
            trustedPosting,
          },
          {
            postId: result.postId ?? null,
            status: result.status,
            side,
          },
        );
        return result;
      }
      const credentials = readXPosterCredentialsFromEnv();
      if (!credentials) {
        fail(409, "X credentials are not configured.");
      }
      const result = await postToX({
        text,
        credentials,
      });
      if (!result.ok) {
        this.logLifeOpsWarn(
          "x_post",
          result.error ?? "Failed to create X post.",
          {
            mode: grant.mode,
            statusCode: result.status,
            category: result.category,
          },
        );
        fail(result.status ?? 502, result.error ?? "Failed to create X post.");
      }
      await this.recordXPostAudit(
        `x:${grant.mode}`,
        "x post sent",
        {
          text,
          confirmPost,
          trustedPosting,
        },
        {
          postId: result.postId ?? null,
          status: result.status,
        },
      );
      return {
        ok: true,
        status: result.status,
        postId: result.postId,
        category: result.category,
      };
    }
  } as MixinClass<TBase, LifeOpsXService>;
}

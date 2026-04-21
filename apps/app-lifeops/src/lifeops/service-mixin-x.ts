// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  CreateLifeOpsXPostRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorGrant,
  LifeOpsXConnectorStatus,
  LifeOpsXDm,
  LifeOpsXPostResponse,
  UpsertLifeOpsXConnectorRequest,
} from "@elizaos/app-lifeops/contracts";
import {
  LIFEOPS_X_CAPABILITIES,
} from "@elizaos/app-lifeops/contracts";
import { createLifeOpsConnectorGrant } from "./repository.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalBoolean,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  normalizeOptionalConnectorMode,
} from "./service-normalize-connector.js";
import {
  normalizeOptionalRecord,
} from "./service-helpers-misc.js";
import { postToX, readXPosterCredentialsFromEnv } from "./x-poster.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export interface LifeOpsXService {
  getXConnectorStatus(
    requestedMode?: LifeOpsConnectorMode,
  ): Promise<LifeOpsXConnectorStatus>;
  upsertXConnector(
    request: UpsertLifeOpsXConnectorRequest,
  ): Promise<LifeOpsXConnectorStatus>;
  createXPost(request: CreateLifeOpsXPostRequest): Promise<LifeOpsXPostResponse>;
}

type LifeOpsXConnectorCapability =
  | "x.read"
  | "x.write"
  | "x.dm.read"
  | "x.dm.write";

function normalizeXCapabilityRequest(value: unknown): LifeOpsXConnectorCapability[] {
  const entries = Array.isArray(value) ? value : [];
  if (entries.length === 0) {
    fail(400, "capabilities must include at least one X capability");
  }
  const capabilities = entries.map((entry) =>
    normalizeEnumValue(entry, "capabilities", LIFEOPS_X_CAPABILITIES),
  );
  return [...new Set(capabilities)];
}

export function withX<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsXService> {
  return class extends Base {
    async getXConnectorStatus(
      requestedMode?: LifeOpsConnectorMode,
    ): Promise<LifeOpsConnectorGrant | null> {
      const mode =
        normalizeOptionalConnectorMode(requestedMode, "mode") ?? "local";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "x",
        mode,
      );
      if (grant) {
        return grant;
      }
      if (mode === "local" && readXPosterCredentialsFromEnv()) {
        return createSyntheticXGrant(this.agentId(), mode);
      }
      return null;
    }

    async getXConnectorStatus(
      requestedMode?: LifeOpsConnectorMode,
    ): Promise<LifeOpsXConnectorStatus> {
      const mode =
        normalizeOptionalConnectorMode(requestedMode, "mode") ?? "local";
      const grant = await this.resolveXGrant(mode);
      const hasCredentials = Boolean(readXPosterCredentialsFromEnv());
      const capabilities = resolveXCapabilities(grant?.capabilities, hasCredentials);
      const capabilityFlags = capabilitySummary(capabilities);
      return {
        provider: "x",
        mode,
        connected:
          mode === "cloud_managed"
            ? Boolean(grant?.cloudConnectionId ?? grant)
            : hasCredentials,
        grantedCapabilities: capabilities,
        grantedScopes: grant?.grantedScopes ?? [],
        identity:
          grant && Object.keys(grant.identity).length > 0 ? grant.identity : null,
        hasCredentials,
        ...capabilityFlags,
        dmInbound: capabilityFlags.dmRead,
        grant,
      };
    }

    async upsertXConnector(
      request: UpsertLifeOpsXConnectorRequest,
    ): Promise<LifeOpsXConnectorStatus> {
      const mode =
        normalizeOptionalConnectorMode(request.mode, "mode") ?? "local";
      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "x",
        mode,
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
      return this.getXConnectorStatus(mode);
    }

    async getXDmDigest(opts: { limit?: number; conversationId?: string } = {}): Promise<{
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
          readAt: request.markRead ? dm.readAt ?? now : dm.readAt,
          repliedAt: request.markReplied ? dm.repliedAt ?? now : dm.repliedAt,
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
    }): Promise<{ ok: boolean; status: number | null; error?: string }> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const grant = await this.resolveXGrant(mode);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const capabilities = new Set(
        resolveXCapabilities(grant.capabilities, Boolean(readXPosterCredentialsFromEnv())),
      );
      if (!capabilities.has("x.dm.write")) {
        fail(403, "X DM write access has not been granted.");
      }
      const participantId = normalizeOptionalString(request.participantId)?.trim();
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

    async createXPost(
      request: CreateLifeOpsXPostRequest,
    ): Promise<LifeOpsXPostResponse> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const grant = await this.resolveXGrant(mode);
      if (!grant) {
        fail(409, "X is not connected.");
      }
      const capabilities = new Set(
        resolveXCapabilities(grant.capabilities, Boolean(readXPosterCredentialsFromEnv())),
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

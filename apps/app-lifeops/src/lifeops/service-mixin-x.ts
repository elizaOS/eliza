// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  CreateLifeOpsXPostRequest,
  LifeOpsConnectorMode,
  LifeOpsXConnectorStatus,
  LifeOpsXPostResponse,
  UpsertLifeOpsXConnectorRequest,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_X_CAPABILITIES,
} from "@elizaos/shared/contracts/lifeops";
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
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function normalizeXCapabilityRequest(
  value: unknown,
): Array<"x.read" | "x.write"> {
  const entries = Array.isArray(value) ? value : [];
  if (entries.length === 0) {
    fail(400, "capabilities must include at least one X capability");
  }
  const capabilities = entries.map((entry) =>
    normalizeEnumValue(entry, "capabilities", LIFEOPS_X_CAPABILITIES),
  );
  return [...new Set(capabilities)];
}

/** @internal */
export function withX<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsXServiceMixin extends Base {
    async getXConnectorStatus(
      requestedMode?: LifeOpsConnectorMode,
    ): Promise<LifeOpsXConnectorStatus> {
      const mode =
        normalizeOptionalConnectorMode(requestedMode, "mode") ?? "local";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "x",
        mode,
      );
      const capabilities = (grant?.capabilities ?? []).filter(
        (candidate): candidate is "x.read" | "x.write" =>
          candidate === "x.read" || candidate === "x.write",
      );
      return {
        provider: "x",
        mode,
        connected: Boolean(grant && readXPosterCredentialsFromEnv()),
        grantedCapabilities: capabilities,
        grantedScopes: grant?.grantedScopes ?? [],
        identity:
          grant && Object.keys(grant.identity).length > 0 ? grant.identity : null,
        hasCredentials: Boolean(readXPosterCredentialsFromEnv()),
        dmInbound: capabilities.includes("x.read"),
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

    async createXPost(
      request: CreateLifeOpsXPostRequest,
    ): Promise<LifeOpsXPostResponse> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const grant = await this.requireXGrant(mode);
      const capabilities = new Set(
        (grant.capabilities ?? []).filter(
          (candidate) => candidate === "x.read" || candidate === "x.write",
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
  }

  return LifeOpsXServiceMixin;
}

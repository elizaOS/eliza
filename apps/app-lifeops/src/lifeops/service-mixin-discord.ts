// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  LifeOpsConnectorSide,
  LifeOpsDiscordCapability,
  LifeOpsDiscordConnectorStatus,
  StartLifeOpsDiscordConnectorRequest,
  StartLifeOpsDiscordConnectorResponse,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_DISCORD_CAPABILITIES } from "@elizaos/shared/contracts/lifeops";
import { createLifeOpsConnectorGrant } from "./repository.js";
import {
  completeDiscordConnectorOAuth,
  deleteStoredDiscordToken,
  type DiscordConnectorCallbackResult,
  DiscordOAuthError,
  readStoredDiscordToken,
  resolveDiscordOAuthConfig,
  startDiscordConnectorOAuth,
} from "./discord-oauth.js";
import { fail } from "./service-normalize.js";
import {
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withDiscord<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsDiscordServiceMixin extends Base {
    async getDiscordConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
      );

      const tokenRef = grant?.tokenRef ?? null;
      const stored = tokenRef ? readStoredDiscordToken(tokenRef) : null;
      const capabilities = (grant?.capabilities ?? []).filter(
        (candidate): candidate is LifeOpsDiscordCapability =>
          candidate === "discord.read" || candidate === "discord.send",
      );

      let reason: LifeOpsDiscordConnectorStatus["reason"] = "disconnected";
      if (grant && stored) {
        reason =
          stored.expiresAt > Date.now() ? "connected" : "auth_expired";
      } else if (grant && !stored) {
        reason = "auth_expired";
      }

      const identity =
        grant && Object.keys(grant.identity).length > 0
          ? (grant.identity as LifeOpsDiscordConnectorStatus["identity"])
          : null;

      return {
        provider: "discord",
        side: normalizedSide,
        connected: reason === "connected",
        reason,
        identity,
        grantedCapabilities: capabilities,
        grantedScopes: grant?.grantedScopes ?? [],
        expiresAt: stored
          ? new Date(stored.expiresAt).toISOString()
          : null,
        hasRefreshToken: Boolean(stored?.refreshToken),
        grant,
      };
    }

    async startDiscordConnector(
      request: StartLifeOpsDiscordConnectorRequest,
      requestUrl: URL,
    ): Promise<StartLifeOpsDiscordConnectorResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";

      try {
        const result = startDiscordConnectorOAuth({
          agentId: this.agentId(),
          side,
          requestUrl,
          redirectUrl: request.redirectUrl,
        });

        return {
          provider: "discord",
          side: result.side,
          authUrl: result.authUrl,
        };
      } catch (error) {
        if (error instanceof DiscordOAuthError) {
          fail(error.status, error.message);
        }
        throw error;
      }
    }

    async completeDiscordConnectorCallback(
      callbackUrl: URL,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      let result: DiscordConnectorCallbackResult;
      try {
        result = await completeDiscordConnectorOAuth({ callbackUrl });
      } catch (error) {
        if (error instanceof DiscordOAuthError) {
          fail(error.status, error.message);
        }
        throw error;
      }

      const capabilities: LifeOpsDiscordCapability[] = result.grantedScopes
        .includes("messages.read")
        ? ["discord.read"]
        : [];

      const existing = await this.repository.getConnectorGrant(
        result.agentId,
        "discord",
        "local",
      );

      const grant = existing
        ? {
            ...existing,
            identity: result.identity,
            grantedScopes: result.grantedScopes,
            capabilities,
            tokenRef: result.tokenRef,
            metadata: {
              ...existing.metadata,
              hasRefreshToken: result.hasRefreshToken,
              expiresAt: result.expiresAt,
            },
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: result.agentId,
            provider: "discord",
            identity: result.identity,
            grantedScopes: result.grantedScopes,
            capabilities,
            tokenRef: result.tokenRef,
            mode: "local",
            metadata: {
              hasRefreshToken: result.hasRefreshToken,
              expiresAt: result.expiresAt,
            },
            lastRefreshAt: new Date().toISOString(),
          });

      await this.repository.upsertConnectorGrant(grant);
      await this.recordConnectorAudit(
        `discord:local`,
        "discord connector authorized via OAuth",
        { side: result.side },
        { capabilities, grantedScopes: result.grantedScopes },
      );

      return this.getDiscordConnectorStatus(result.side);
    }

    async disconnectDiscord(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";

      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
      );

      if (grant?.tokenRef) {
        deleteStoredDiscordToken(grant.tokenRef);
      }

      if (grant) {
        await this.repository.upsertConnectorGrant({
          ...grant,
          tokenRef: null,
          capabilities: [],
          grantedScopes: [],
          identity: {},
          metadata: {
            ...grant.metadata,
            disconnectedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        });
        await this.recordConnectorAudit(
          `discord:local`,
          "discord connector disconnected",
          { side: normalizedSide },
          {},
        );
      }

      return this.getDiscordConnectorStatus(normalizedSide);
    }
  }

  return LifeOpsDiscordServiceMixin;
}

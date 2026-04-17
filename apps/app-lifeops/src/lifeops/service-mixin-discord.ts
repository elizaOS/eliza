// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  LifeOpsConnectorSide,
  LifeOpsDiscordCapability,
  LifeOpsDiscordConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_DISCORD_CAPABILITIES, capabilitiesForSide } from "@elizaos/shared/contracts/lifeops";
import { createLifeOpsConnectorGrant } from "./repository.js";
import { fail } from "./service-normalize.js";
import {
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

const DISCORD_LOCAL_SERVICE_NAME = "discord-local";

export interface DiscordLocalUser {
  id?: string;
  username?: string;
  discriminator?: string;
  global_name?: string;
  email?: string;
}

export interface DiscordLocalStatus {
  available?: boolean;
  connected?: boolean;
  authenticated?: boolean;
  currentUser?: DiscordLocalUser | null;
  subscribedChannelIds?: string[];
  configuredChannelIds?: string[];
  scopes?: string[];
  lastError?: string | null;
  ipcPath?: string | null;
}

export interface DiscordLocalGuild {
  id: string;
  name?: string;
}

export interface DiscordLocalChannel {
  id: string;
  name?: string;
  type?: number;
  recipients?: Array<{
    id: string;
    username?: string;
    global_name?: string;
  }>;
}

export interface DiscordLocalServiceLike {
  getStatus(): DiscordLocalStatus;
  authorize(): Promise<DiscordLocalStatus>;
  disconnectSession(): Promise<void>;
  listGuilds(): Promise<DiscordLocalGuild[]>;
  listChannels(guildId: string): Promise<DiscordLocalChannel[]>;
  subscribeChannelMessages(channelIds: string[]): Promise<string[]>;
}

function toDiscordIdentity(
  currentUser: DiscordLocalUser | null | undefined,
  fallback: Record<string, unknown> | null,
): LifeOpsDiscordConnectorStatus["identity"] {
  if (currentUser) {
    return {
      id: currentUser.id,
      username: currentUser.global_name ?? currentUser.username,
      discriminator: currentUser.discriminator,
      email: currentUser.email,
    };
  }
  if (fallback && Object.keys(fallback).length > 0) {
    return fallback as LifeOpsDiscordConnectorStatus["identity"];
  }
  return null;
}

/** @internal */
export function withDiscord<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsDiscordServiceMixin extends Base {
    resolveDiscordLocalService(): DiscordLocalServiceLike | null {
      return (this.runtime.getService(DISCORD_LOCAL_SERVICE_NAME) as
        | DiscordLocalServiceLike
        | null
        | undefined) ?? null;
    }

    async getDiscordConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );
      const service = this.resolveDiscordLocalService();
      const serviceStatus = service?.getStatus() ?? null;
      const capabilities = (grant?.capabilities ?? []).filter(
        (candidate): candidate is LifeOpsDiscordCapability =>
          candidate === "discord.read" || candidate === "discord.send",
      );
      const connected = Boolean(serviceStatus?.authenticated);

      return {
        provider: "discord",
        side: normalizedSide,
        available: Boolean(serviceStatus?.available),
        connected,
        authenticated: Boolean(serviceStatus?.authenticated),
        reason: connected
          ? "connected"
          : grant
            ? "session_revoked"
            : "disconnected",
        identity: toDiscordIdentity(
          serviceStatus?.currentUser ?? null,
          grant?.identity ?? null,
        ),
        grantedCapabilities: capabilities,
        grantedScopes: serviceStatus?.scopes ?? grant?.grantedScopes ?? [],
        configuredChannelIds:
          serviceStatus?.configuredChannelIds ?? [],
        subscribedChannelIds:
          serviceStatus?.subscribedChannelIds ?? [],
        expiresAt: null,
        hasRefreshToken: false,
        lastError: serviceStatus?.lastError ?? null,
        ipcPath: serviceStatus?.ipcPath ?? null,
        grant,
      };
    }

    async authorizeDiscordConnector(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const service = this.resolveDiscordLocalService();
      if (!service) {
        fail(503, "Discord desktop integration is not available.");
      }

      const status = await service.authorize();
      const currentUser = status.currentUser ?? null;
      const identity = toDiscordIdentity(currentUser, null) ?? {};
      const grantedScopes = status.scopes ?? [];
      const capabilities: LifeOpsDiscordCapability[] =
        status.authenticated === true
          ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
          : [];
      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );

      const grant = existing
        ? {
            ...existing,
            identity,
            grantedScopes,
            capabilities,
            metadata: {
              ...existing.metadata,
              subscribedChannelIds: status.subscribedChannelIds ?? [],
              configuredChannelIds: status.configuredChannelIds ?? [],
            },
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "discord",
            identity,
            grantedScopes,
            capabilities,
            tokenRef: null,
            mode: "local",
            side: normalizedSide,
            metadata: {
              subscribedChannelIds: status.subscribedChannelIds ?? [],
              configuredChannelIds: status.configuredChannelIds ?? [],
            },
            lastRefreshAt: new Date().toISOString(),
          });

      await this.repository.upsertConnectorGrant(grant);
      await this.recordConnectorAudit(
        `discord:${normalizedSide}`,
        "discord desktop connector authorized",
        { side: normalizedSide },
        {
          grantedScopes,
          configuredChannelIds: status.configuredChannelIds ?? [],
        },
      );

      return this.getDiscordConnectorStatus(normalizedSide);
    }

    async listDiscordGuilds(
      side?: LifeOpsConnectorSide,
    ): Promise<{ guilds: DiscordLocalGuild[] }> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const service = this.resolveDiscordLocalService();
      if (!service) {
        fail(503, "Discord desktop integration is not available.");
      }
      const status = await this.getDiscordConnectorStatus(normalizedSide);
      if (!status.authenticated) {
        fail(409, "Connect Discord before listing guilds.");
      }
      return {
        guilds: await service.listGuilds(),
      };
    }

    async listDiscordChannels(
      guildId: string,
      side?: LifeOpsConnectorSide,
    ): Promise<{ channels: DiscordLocalChannel[] }> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const service = this.resolveDiscordLocalService();
      if (!service) {
        fail(503, "Discord desktop integration is not available.");
      }
      if (!guildId.trim()) {
        fail(400, "guildId is required");
      }
      const status = await this.getDiscordConnectorStatus(normalizedSide);
      if (!status.authenticated) {
        fail(409, "Connect Discord before listing channels.");
      }
      return {
        channels: await service.listChannels(guildId.trim()),
      };
    }

    async saveDiscordSubscriptions(
      channelIds: string[],
      side?: LifeOpsConnectorSide,
    ): Promise<{ subscribedChannelIds: string[] }> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const service = this.resolveDiscordLocalService();
      if (!service) {
        fail(503, "Discord desktop integration is not available.");
      }
      const subscribedChannelIds =
        await service.subscribeChannelMessages(channelIds);
      const status = service.getStatus();
      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );
      const identity =
        toDiscordIdentity(status.currentUser ?? null, existing?.identity ?? null) ??
        {};

      const grant = existing
        ? {
            ...existing,
            identity,
            grantedScopes: status.scopes ?? existing.grantedScopes,
            capabilities:
              status.authenticated === true
                ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
                : [],
            metadata: {
              ...existing.metadata,
              subscribedChannelIds,
              configuredChannelIds: status.configuredChannelIds ?? [],
            },
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "discord",
            identity,
            grantedScopes: status.scopes ?? [],
            capabilities:
              status.authenticated === true
                ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
                : [],
            tokenRef: null,
            mode: "local",
            side: normalizedSide,
            metadata: {
              subscribedChannelIds,
              configuredChannelIds: status.configuredChannelIds ?? [],
            },
            lastRefreshAt: new Date().toISOString(),
          });

      await this.repository.upsertConnectorGrant(grant);

      return {
        subscribedChannelIds,
      };
    }

    async disconnectDiscord(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const service = this.resolveDiscordLocalService();

      if (service) {
        await service.disconnectSession();
      }

      await this.repository.deleteConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );

      await this.recordConnectorAudit(
        `discord:${normalizedSide}`,
        "discord desktop connector disconnected",
        { side: normalizedSide },
        {},
      );

      return {
        provider: "discord",
        side: normalizedSide,
        available: Boolean(service?.getStatus().available),
        connected: false,
        authenticated: false,
        reason: "disconnected",
        identity: null,
        grantedCapabilities: [],
        grantedScopes: [],
        configuredChannelIds: [],
        subscribedChannelIds: [],
        expiresAt: null,
        hasRefreshToken: false,
        lastError: null,
        ipcPath: service?.getStatus().ipcPath ?? null,
        grant: null,
      };
    }
  }

  return LifeOpsDiscordServiceMixin;
}

// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsDiscordCapability,
  LifeOpsDiscordConnectorStatus,
  LifeOpsMessagingConnectorReason,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_DISCORD_CAPABILITIES,
  capabilitiesForSide,
} from "@elizaos/shared/contracts/lifeops";
import { logger } from "@elizaos/core";
import { createLifeOpsConnectorGrant } from "./repository.js";
import {
  closeDiscordTab,
  discordBrowserWorkspaceAvailable,
  ensureDiscordTab,
  probeDiscordTab,
  type DiscordTabProbe,
} from "./discord-browser-scraper.js";
import { fail } from "./service-normalize.js";
import { normalizeOptionalConnectorSide } from "./service-normalize-connector.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function identityFromProbe(
  probe: DiscordTabProbe | null,
  fallback: Record<string, unknown> | null,
): LifeOpsDiscordConnectorStatus["identity"] {
  if (probe?.loggedIn && probe.identity.username) {
    return {
      id: probe.identity.id ?? undefined,
      username: probe.identity.username,
      discriminator: probe.identity.discriminator ?? undefined,
    };
  }
  if (fallback && Object.keys(fallback).length > 0) {
    return fallback as LifeOpsDiscordConnectorStatus["identity"];
  }
  return null;
}

function reasonFor(args: {
  available: boolean;
  loggedIn: boolean;
  hasGrant: boolean;
  hasTab: boolean;
}): LifeOpsMessagingConnectorReason {
  if (!args.available) return "disconnected";
  if (args.loggedIn) return "connected";
  if (args.hasTab || args.hasGrant) return "pairing";
  return "disconnected";
}

function tabIdFromGrant(grant: LifeOpsConnectorGrant | null): string | null {
  if (!grant) return null;
  const raw = (grant.metadata as Record<string, unknown> | undefined)?.tabId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** @internal */
export function withDiscord<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsDiscordServiceMixin extends Base {
    async probeTab(
      tabId: string | null,
    ): Promise<DiscordTabProbe | null> {
      if (!tabId) return null;
      try {
        return await probeDiscordTab(tabId);
      } catch (error) {
        logger.debug(
          `[lifeops-discord] probe failed for tab ${tabId}: ${String(error)}`,
        );
        return null;
      }
    }

    async getDiscordConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const available = discordBrowserWorkspaceAvailable();
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );
      const tabId = tabIdFromGrant(grant);
      const probe = available ? await this.probeTab(tabId) : null;
      const loggedIn = probe?.loggedIn === true;
      const capabilities = (grant?.capabilities ?? []).filter(
        (candidate): candidate is LifeOpsDiscordCapability =>
          candidate === "discord.read" || candidate === "discord.send",
      );

      return {
        provider: "discord",
        side: normalizedSide,
        available,
        connected: loggedIn,
        reason: reasonFor({
          available,
          loggedIn,
          hasGrant: Boolean(grant),
          hasTab: Boolean(tabId),
        }),
        identity: identityFromProbe(probe, grant?.identity ?? null),
        grantedCapabilities: capabilities,
        lastError: null,
        tabId,
        grant,
      };
    }

    /**
     * Open (or focus) a Milady browser tab pointed at discord.com so the
     * user can log in. Persists the tab id on the connector grant so
     * subsequent status calls can re-probe it.
     */
    async authorizeDiscordConnector(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      if (!discordBrowserWorkspaceAvailable()) {
        fail(
          503,
          "Discord connector requires the Milady desktop app. Open Milady and try again.",
        );
      }

      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );

      const { tabId } = await ensureDiscordTab({
        agentId: this.agentId(),
        side: normalizedSide,
        existingTabId: tabIdFromGrant(existing),
        show: true,
      });

      const probe = await this.probeTab(tabId);
      const loggedIn = probe?.loggedIn === true;
      const capabilities = loggedIn
        ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
        : existing?.capabilities ?? [];
      const identity =
        identityFromProbe(probe, existing?.identity ?? null) ?? {};

      const grant = existing
        ? {
            ...existing,
            identity,
            capabilities,
            metadata: {
              ...existing.metadata,
              tabId,
            },
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "discord",
            identity,
            grantedScopes: [],
            capabilities,
            tokenRef: null,
            mode: "local",
            side: normalizedSide,
            metadata: { tabId },
            lastRefreshAt: new Date().toISOString(),
          });

      await this.repository.upsertConnectorGrant(grant);
      await this.recordConnectorAudit(
        `discord:${normalizedSide}`,
        "discord browser connector authorized",
        { side: normalizedSide },
        { tabId, loggedIn },
      );

      return this.getDiscordConnectorStatus(normalizedSide);
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
        normalizedSide,
      );
      const tabId = tabIdFromGrant(grant);

      if (tabId && discordBrowserWorkspaceAvailable()) {
        try {
          await closeDiscordTab(tabId);
        } catch (error) {
          logger.debug(
            `[lifeops-discord] failed to close tab ${tabId}: ${String(error)}`,
          );
        }
      }

      await this.repository.deleteConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );

      await this.recordConnectorAudit(
        `discord:${normalizedSide}`,
        "discord browser connector disconnected",
        { side: normalizedSide },
        {},
      );

      return {
        provider: "discord",
        side: normalizedSide,
        available: discordBrowserWorkspaceAvailable(),
        connected: false,
        reason: "disconnected",
        identity: null,
        grantedCapabilities: [],
        lastError: null,
        tabId: null,
        grant: null,
      };
    }
  }

  return LifeOpsDiscordServiceMixin;
}

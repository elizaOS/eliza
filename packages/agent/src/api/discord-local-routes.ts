import type http from "node:http";
import type { ElizaConfig } from "../config/config.js";
import type { ConnectorConfig } from "../config/types.eliza.js";
import { DISCORD_LOCAL_SERVICE_NAME } from "../runtime/discord-local-plugin.js";
import { registerEscalationChannel } from "../services/escalation.js";
import { setOwnerContact } from "./owner-contact-helpers.js";
import type { RouteHelpers } from "./route-helpers.js";

interface DiscordLocalServiceLike {
  getStatus(): Record<string, unknown>;
  authorize(): Promise<Record<string, unknown>>;
  disconnectSession(): Promise<void>;
  listGuilds(): Promise<Array<Record<string, unknown>>>;
  listChannels(guildId: string): Promise<Array<Record<string, unknown>>>;
  subscribeChannelMessages(channelIds: string[]): Promise<string[]>;
}

export interface DiscordLocalRouteState {
  config: ElizaConfig;
  runtime?: {
    getService(type: string): unknown;
  };
  saveConfig: () => void;
}

function resolveService(
  state: DiscordLocalRouteState,
): DiscordLocalServiceLike | null {
  if (!state.runtime) {
    return null;
  }
  const raw = state.runtime.getService(DISCORD_LOCAL_SERVICE_NAME);
  return (raw as DiscordLocalServiceLike | null | undefined) ?? null;
}

function getConnectorConfig(state: DiscordLocalRouteState): ConnectorConfig {
  const connectors =
    state.config.connectors ??
    ((state.config as Record<string, unknown>).channels as
      | Record<string, ConnectorConfig>
      | undefined) ??
    {};

  const current = connectors.discordLocal;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as ConnectorConfig;
  }
  return {};
}

function updateConnectorConfig(
  state: DiscordLocalRouteState,
  nextConfig: ConnectorConfig,
): void {
  if (!state.config.connectors) {
    state.config.connectors = {};
  }
  state.config.connectors.discordLocal = nextConfig;
  state.saveConfig();
}

export async function handleDiscordLocalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: DiscordLocalRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  if (!pathname.startsWith("/api/discord-local")) {
    return false;
  }

  const service = resolveService(state);

  if (method === "GET" && pathname === "/api/discord-local/status") {
    helpers.json(
      res,
      service
        ? service.getStatus()
        : {
            available: false,
            connected: false,
            authenticated: false,
            reason: "discord-local service not registered",
          },
    );
    return true;
  }

  if (method === "POST" && pathname === "/api/discord-local/authorize") {
    if (!service) {
      helpers.error(res, "discord-local service not registered", 503);
      return true;
    }
    try {
      helpers.json(res, await service.authorize());
    } catch (error) {
      helpers.error(
        res,
        `failed to authorize discord-local: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/discord-local/disconnect") {
    if (!service) {
      helpers.error(res, "discord-local service not registered", 503);
      return true;
    }

    try {
      await service.disconnectSession();
      helpers.json(res, { ok: true });
    } catch (error) {
      helpers.error(
        res,
        `failed to disconnect discord-local: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/discord-local/guilds") {
    if (!service) {
      helpers.error(res, "discord-local service not registered", 503);
      return true;
    }
    try {
      const guilds = await service.listGuilds();
      helpers.json(res, { guilds, count: guilds.length });
    } catch (error) {
      helpers.error(
        res,
        `failed to list discord-local guilds: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/discord-local/channels") {
    if (!service) {
      helpers.error(res, "discord-local service not registered", 503);
      return true;
    }

    const url = new URL(req.url ?? pathname, "http://localhost");
    const guildId = url.searchParams.get("guildId")?.trim() ?? "";
    if (!guildId) {
      helpers.error(res, "guildId is required", 400);
      return true;
    }

    try {
      const channels = await service.listChannels(guildId);
      helpers.json(res, { channels, count: channels.length });
    } catch (error) {
      helpers.error(
        res,
        `failed to list discord-local channels: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/discord-local/subscriptions") {
    if (!service) {
      helpers.error(res, "discord-local service not registered", 503);
      return true;
    }

    const body = await helpers.readJsonBody<{ channelIds?: string[] }>(
      req,
      res,
    );
    if (!body) {
      return true;
    }

    const channelIds = Array.isArray(body.channelIds)
      ? Array.from(
          new Set(
            body.channelIds
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter((entry) => entry.length > 0),
          ),
        )
      : [];

    try {
      const subscribedChannelIds =
        await service.subscribeChannelMessages(channelIds);
      const connectorConfig = getConnectorConfig(state);
      updateConnectorConfig(state, {
        ...connectorConfig,
        enabled: connectorConfig.enabled !== false,
        messageChannelIds: subscribedChannelIds,
      });
      // Auto-populate owner contact so LifeOps can deliver reminders
      if (subscribedChannelIds.length > 0) {
        setOwnerContact(state.config as Parameters<typeof setOwnerContact>[0], {
          source: "discord",
          channelId: subscribedChannelIds[0],
        });
        // Add Discord to the escalation channel list so it is reachable
        // without the user explicitly configuring escalation.
        registerEscalationChannel("discord");
      }
      helpers.json(res, { subscribedChannelIds });
    } catch (error) {
      helpers.error(
        res,
        `failed to update discord-local subscriptions: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return true;
  }

  return false;
}

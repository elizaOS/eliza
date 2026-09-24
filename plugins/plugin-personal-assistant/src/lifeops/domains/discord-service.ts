/**
 * Discord domain for LifeOps: projects the owner's Discord DM inbox and message
 * search into assistant connector DTOs by driving the desktop-CDP user-account
 * scraper in `@elizaos/plugin-discord`. This layer owns the LifeOps connector
 * grant/degradation projection only; capture and send happen in the discord plugin.
 */
import {
  ElizaError,
  logger,
  requireConfirmedSendHandlerDelivery,
  type SendHandlerReceipt,
  type TargetInfo,
} from "@elizaos/core";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
} from "@elizaos/plugin-browser";
import {
  captureDiscordDeliveryStatus,
  closeDiscordTab,
  type DiscordDesktopCdpStatus,
  type DiscordMessageSearchResult,
  type DiscordTabProbe,
  discordBrowserWorkspaceAvailable,
  emptyDiscordDmInboxProbe,
  ensureDiscordTab,
  getDiscordDesktopCdpStatus,
  probeDiscordTab,
  relaunchDiscordDesktopForCdp,
  searchDiscordMessages,
  sendDiscordViaDesktopCdp,
} from "@elizaos/plugin-discord/user-account-scraper";
import type {
  LifeOpsBrowserSession,
  LifeOpsConnectorDegradation,
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsDiscordCapability,
  LifeOpsDiscordConnectorStatus,
  LifeOpsMessagingConnectorReason,
  LifeOpsOwnerBrowserAccessSource,
  LifeOpsOwnerBrowserAccessStatus,
  LifeOpsOwnerBrowserAuthState,
  LifeOpsOwnerBrowserNextAction,
  LifeOpsOwnerBrowserTabState,
} from "@elizaos/shared";
import { LIFEOPS_DISCORD_CAPABILITIES } from "@elizaos/shared";
import type { CreateLifeOpsBrowserSessionRequest } from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  ConnectorDeliveryEvidenceError,
  ConnectorSenderChangedError,
} from "../messaging/connector-delivery-evidence.js";
import { createLifeOpsConnectorGrant } from "../repository.js";
import {
  searchDiscordMessagesWithRuntimeService,
  sendDiscordMessageWithRuntimeService,
} from "../runtime-service-delegates.js";
import { fail } from "../service-normalize.js";
import { normalizeOptionalConnectorSide } from "../service-normalize-connector.js";

const DISCORD_CHANNEL_URL_RE = /\/channels\/([^/?#]+)\/([^/?#]+)/;
const DISCORD_SEND_SETTLE_MS = 1_500;
const FULL_DISCORD_CAPABILITIES = [...LIFEOPS_DISCORD_CAPABILITIES];

/**
 * Browser-domain methods and the base browser-pause helper the Discord domain
 * depends on. These live on other domains (`withBrowser`) or on the base
 * (`isBrowserPaused`), so they are injected as typed callbacks rather than read
 * off {@link LifeOpsContext}.
 */
export type DiscordDomainDeps = {
  createBrowserSession(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;
  getBrowserSession(sessionId: string): Promise<LifeOpsBrowserSession>;
  getBrowserSettings(): Promise<BrowserBridgeSettings>;
  getCurrentBrowserPage(): Promise<BrowserBridgePageContext | null>;
  listBrowserCompanions(): Promise<BrowserBridgeCompanionStatus[]>;
  listBrowserTabs(): Promise<BrowserBridgeTabSummary[]>;
  isBrowserPaused(settings: BrowserBridgeSettings): boolean;
};

type DiscordPluginServiceLike = {
  isReady?: () => boolean;
  client?: {
    isReady?: () => boolean;
    user?: {
      id?: string;
      username?: string;
      displayName?: string;
      globalName?: string;
      discriminator?: string | null;
    } | null;
  } | null;
};

/**
 * Success DTO for a Discord send, naming the target that was actually
 * addressed: `channelId` for channel/DM-channel sends, `userId` for
 * user-targeted DM sends where plugin-discord resolves the DM channel itself
 * (`users.fetch` → `createDM`). The two id spaces are disjoint, so the field
 * name is the target's type — a user id must never be reported as a channelId.
 */
export type DiscordSendMessageResult = {
  provider: "discord";
  side: LifeOpsConnectorSide;
  ok: true;
  deliveryStatus: "sent" | "sending" | "failed" | "unknown";
  providerMessageId: string | null;
  receipt: SendHandlerReceipt | null;
} & ({ channelId: string } | { userId: string });

export type DiscordConnectorVerification = {
  provider: "discord";
  side: LifeOpsConnectorSide;
  verifiedAt: string;
  status: LifeOpsDiscordConnectorStatus;
  send: {
    attempted: boolean;
    ok: boolean;
    error: string | null;
    channelId: string | null;
    message: string;
    deliveryStatus: "sent" | "sending" | "failed" | "unknown" | null;
  };
};

function getDiscordPluginService(
  runtime: LifeOpsContext["runtime"],
): DiscordPluginServiceLike | null {
  const service = runtime.getService?.("discord") as
    | DiscordPluginServiceLike
    | null
    | undefined;
  return service && typeof service === "object" ? service : null;
}

function discordPluginConnected(
  service: DiscordPluginServiceLike | null,
): boolean {
  try {
    if (typeof service?.isReady === "function") {
      return service.isReady();
    }
    if (typeof service?.client?.isReady === "function") {
      return service.client.isReady();
    }
  } catch {
    return false;
  }
  return false;
}

function discordPluginIdentity(
  service: DiscordPluginServiceLike | null,
): LifeOpsDiscordConnectorStatus["identity"] {
  const user = service?.client?.user;
  if (!user?.id && !user?.username) {
    return null;
  }
  return {
    ...(user.id ? { id: user.id } : {}),
    ...(user.username || user.globalName || user.displayName
      ? { username: user.username ?? user.globalName ?? user.displayName }
      : {}),
    ...(user.discriminator ? { discriminator: user.discriminator } : {}),
  };
}

function discordAgentPluginDegradations(
  connected: boolean,
): LifeOpsConnectorDegradation[] {
  if (connected) {
    return [];
  }
  return [
    {
      axis: "transport-offline",
      code: "discord_plugin_unavailable",
      message:
        "Agent-side Discord is served by @elizaos/plugin-discord. Configure and enable the Discord bot connector; LifeOps will not open a separate agent browser session.",
      retryable: true,
    },
  ];
}

function normalizeDiscordCapabilities(
  capabilities: readonly string[] | null | undefined,
): LifeOpsDiscordCapability[] {
  return (capabilities ?? []).filter(
    (candidate): candidate is LifeOpsDiscordCapability =>
      candidate === "discord.read" || candidate === "discord.send",
  );
}

function sameStringList(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isDiscordHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "discord.com" || u.hostname.endsWith(".discord.com");
  } catch {
    return false;
  }
}

function discordChannelIdFromUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const match = url.match(DISCORD_CHANNEL_URL_RE);
  const channelId = match?.[2]?.trim();
  return channelId && channelId.length > 0 ? channelId : null;
}

function selectedDiscordChannelIdFromStatus(
  status: LifeOpsDiscordConnectorStatus,
): string | null {
  if (status.dmInbox.selectedChannelId) {
    return status.dmInbox.selectedChannelId;
  }
  for (const access of status.browserAccess ?? []) {
    const channelId = discordChannelIdFromUrl(access.currentUrl);
    if (channelId) return channelId;
  }
  return null;
}

function memoryToDiscordMessageSearchResult(
  memory: unknown,
): DiscordMessageSearchResult {
  const record =
    memory && typeof memory === "object"
      ? (memory as Record<string, unknown>)
      : {};
  const content =
    record.content && typeof record.content === "object"
      ? (record.content as Record<string, unknown>)
      : {};
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : {};
  const sender =
    metadata.sender && typeof metadata.sender === "object"
      ? (metadata.sender as Record<string, unknown>)
      : {};
  const createdAt = Number(record.createdAt);
  return {
    id:
      typeof metadata.messageId === "string"
        ? metadata.messageId
        : typeof record.id === "string"
          ? record.id
          : null,
    content: typeof content.text === "string" ? content.text : "",
    authorName:
      typeof content.name === "string"
        ? content.name
        : typeof sender.username === "string"
          ? sender.username
          : null,
    guildId:
      typeof metadata.discordGuildId === "string"
        ? metadata.discordGuildId
        : null,
    channelId:
      typeof metadata.discordChannelId === "string"
        ? metadata.discordChannelId
        : typeof metadata.channelId === "string"
          ? metadata.channelId
          : null,
    timestamp: Number.isFinite(createdAt)
      ? new Date(createdAt).toISOString()
      : null,
    deliveryStatus: "unknown",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityFromProbe(
  probe: DiscordTabProbe | null,
  pluginIdentity: Record<string, unknown> | null,
): LifeOpsDiscordConnectorStatus["identity"] {
  if (probe?.loggedIn && probe.identity.username) {
    return {
      id: probe.identity.id ?? undefined,
      username: probe.identity.username,
      discriminator: probe.identity.discriminator ?? undefined,
    };
  }
  if (pluginIdentity && Object.keys(pluginIdentity).length > 0) {
    return pluginIdentity as LifeOpsDiscordConnectorStatus["identity"];
  }
  return null;
}

function workspaceReasonFor(args: {
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

function browserAuthStateFromProbe(
  probe: DiscordTabProbe | null,
): LifeOpsOwnerBrowserAuthState {
  if (probe?.loggedIn === true) {
    return "logged_in";
  }
  if (probe?.loggedIn === false && probe.url && isDiscordHost(probe.url)) {
    return "logged_out";
  }
  return "unknown";
}

function browserTabState(args: {
  probe: DiscordTabProbe | null;
  hasDiscordTab: boolean;
}): LifeOpsOwnerBrowserTabState {
  if (args.probe?.dmInbox.visible) {
    return "dm_inbox_visible";
  }
  if (args.probe?.url && isDiscordHost(args.probe.url)) {
    return "discord_open";
  }
  if (args.hasDiscordTab) {
    return "background_discord";
  }
  return "missing";
}

function desktopBrowserAccessStatus(args: {
  active: boolean;
  available: boolean;
  probe: DiscordTabProbe | null;
  hasTab: boolean;
}): LifeOpsOwnerBrowserAccessStatus {
  const authState = browserAuthStateFromProbe(args.probe);
  const tabState = browserTabState({
    probe: args.probe,
    hasDiscordTab: args.hasTab,
  });

  let nextAction: LifeOpsOwnerBrowserNextAction = "none";

  if (!args.available) {
    nextAction = "open_desktop_browser";
  } else if (authState === "logged_out") {
    nextAction = "log_in";
  } else if (tabState === "missing") {
    nextAction = "open_discord";
  } else if (authState === "logged_in" && tabState !== "dm_inbox_visible") {
    nextAction = "open_dm_inbox";
  }

  return {
    source: "desktop_browser",
    active: args.active,
    available: args.available,
    browser: null,
    profileId: null,
    profileLabel: null,
    companionId: null,
    companionLabel: null,
    canControl: args.available,
    siteAccessOk: args.available ? true : null,
    currentUrl: args.probe?.url ?? null,
    tabState,
    authState,
    nextAction,
  };
}

function discordDesktopAccessStatus(
  state: DiscordDesktopCdpStatus,
): LifeOpsOwnerBrowserAccessStatus {
  const probe = state.probe;
  const authState = browserAuthStateFromProbe(probe);
  const tabState = browserTabState({
    probe,
    hasDiscordTab:
      Boolean(state.targetUrl && isDiscordHost(state.targetUrl)) ||
      state.cdpAvailable,
  });

  let nextAction: LifeOpsOwnerBrowserNextAction = "none";
  if (state.supported && !state.cdpAvailable) {
    nextAction = "relaunch_discord";
  } else if (authState === "logged_out") {
    nextAction = "log_in";
  } else if (tabState === "missing") {
    nextAction = "open_discord";
  } else if (authState === "logged_in" && tabState !== "dm_inbox_visible") {
    nextAction = "open_dm_inbox";
  }

  return {
    source: "discord_desktop",
    active: state.cdpAvailable,
    available: state.cdpAvailable,
    browser: null,
    profileId: null,
    profileLabel: null,
    companionId: null,
    companionLabel: null,
    canControl: state.cdpAvailable,
    siteAccessOk: state.cdpAvailable ? true : null,
    currentUrl: probe?.url ?? state.targetUrl,
    tabState,
    authState,
    nextAction,
  };
}

function discordDesktopReasonFor(args: {
  available: boolean;
  loggedIn: boolean;
  hasGrant: boolean;
  hasDiscordTarget: boolean;
}): LifeOpsMessagingConnectorReason {
  if (!args.available) return "disconnected";
  if (args.loggedIn) return "connected";
  if (args.hasDiscordTarget || args.hasGrant) return "pairing";
  return "disconnected";
}

/**
 * Owner/agent Discord connector domain: status, authorization, search, send,
 * verify, and disconnect. Browser-domain access (`withBrowser`) and the base
 * `isBrowserPaused` helper are injected via {@link DiscordDomainDeps}.
 */
export class DiscordDomain {
  constructor(
    private readonly ctx: LifeOpsContext,
    private readonly deps: DiscordDomainDeps,
  ) {}

  async lifeOpsDiscordProbeTab(
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

  async lifeOpsDiscordGetBrowserSessionById(
    sessionId: string | null,
  ): Promise<LifeOpsBrowserSession | null> {
    if (!sessionId) return null;
    try {
      return await this.deps.getBrowserSession(sessionId);
    } catch {
      return null;
    }
  }

  async lifeOpsDiscordBuildWorkspaceStatus(
    normalizedSide: LifeOpsConnectorSide,
    grant: LifeOpsConnectorGrant | null,
  ): Promise<LifeOpsDiscordConnectorStatus> {
    const available = discordBrowserWorkspaceAvailable();
    const tabId = tabIdFromGrant(grant);
    const probe = available ? await this.lifeOpsDiscordProbeTab(tabId) : null;
    const loggedIn = probe?.loggedIn === true;
    const browserAccess = [
      desktopBrowserAccessStatus({
        active: available,
        available,
        probe,
        hasTab: Boolean(tabId),
      }),
    ];
    const capabilities =
      loggedIn || probe?.dmInbox.visible
        ? FULL_DISCORD_CAPABILITIES
        : normalizeDiscordCapabilities(grant?.capabilities);
    const identity = identityFromProbe(probe, grant?.identity ?? null);
    const statusGrant =
      loggedIn || probe?.dmInbox.visible
        ? await this.lifeOpsDiscordUpsertGrantForActiveSession({
            side: normalizedSide,
            grant,
            identity: identity ?? {},
            capabilities,
            metadata: { tabId },
          })
        : grant;

    return {
      provider: "discord",
      side: normalizedSide,
      available,
      connected: loggedIn,
      reason: workspaceReasonFor({
        available,
        loggedIn,
        hasGrant: Boolean(grant),
        hasTab: Boolean(tabId),
      }),
      identity,
      dmInbox: probe?.dmInbox ?? emptyDiscordDmInboxProbe(),
      grantedCapabilities: capabilities,
      lastError: null,
      tabId,
      browserAccess,
      grant: statusGrant,
    };
  }

  async lifeOpsDiscordUpsertGrantForActiveSession(args: {
    side: LifeOpsConnectorSide;
    grant: LifeOpsConnectorGrant | null;
    identity: Record<string, unknown>;
    capabilities: readonly LifeOpsDiscordCapability[];
    metadata?: Record<string, unknown>;
  }): Promise<LifeOpsConnectorGrant> {
    const capabilities = normalizeDiscordCapabilities(args.capabilities);
    const metadata = {
      ...(args.grant?.metadata ?? {}),
      ...(args.metadata ?? {}),
    };
    const existing = args.grant;
    if (
      existing &&
      sameStringList(
        normalizeDiscordCapabilities(existing.capabilities),
        capabilities,
      ) &&
      JSON.stringify(existing.identity) === JSON.stringify(args.identity) &&
      JSON.stringify(existing.metadata) === JSON.stringify(metadata)
    ) {
      return existing;
    }

    const now = new Date().toISOString();
    const grant = existing
      ? {
          ...existing,
          identity: args.identity,
          capabilities,
          metadata,
          lastRefreshAt: now,
          updatedAt: now,
        }
      : createLifeOpsConnectorGrant({
          agentId: this.ctx.agentId(),
          provider: "discord",
          identity: args.identity,
          grantedScopes: [],
          capabilities,
          tokenRef: null,
          mode: "local",
          side: args.side,
          metadata,
          lastRefreshAt: now,
        });

    await this.ctx.repository.upsertConnectorGrant(grant);
    return grant;
  }

  async getDiscordConnectorStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsDiscordConnectorStatus> {
    const normalizedSide =
      normalizeOptionalConnectorSide(side, "side") ?? "owner";
    if (normalizedSide === "agent") {
      const pluginService = getDiscordPluginService(this.ctx.runtime);
      const connected = discordPluginConnected(pluginService);
      const degradations = discordAgentPluginDegradations(connected);
      return {
        provider: "discord",
        side: normalizedSide,
        available: connected,
        connected,
        reason: connected ? "connected" : "disconnected",
        identity: discordPluginIdentity(pluginService),
        dmInbox: emptyDiscordDmInboxProbe(),
        grantedCapabilities: connected ? FULL_DISCORD_CAPABILITIES : [],
        lastError: connected
          ? null
          : "Discord plugin is not connected for the agent side.",
        tabId: null,
        browserAccess: [],
        grant: null,
        ...(degradations.length > 0 ? { degradations } : {}),
      };
    }

    const grant = await this.ctx.repository.getConnectorGrant(
      this.ctx.agentId(),
      "discord",
      "local",
      normalizedSide,
    );
    if (normalizedSide === "owner") {
      const discordDesktopState = await getDiscordDesktopCdpStatus();
      const workspaceAvailable = discordBrowserWorkspaceAvailable();
      const workspaceTabId = tabIdFromGrant(grant);
      const workspaceProbe = workspaceAvailable
        ? await this.lifeOpsDiscordProbeTab(workspaceTabId)
        : null;
      const browserAccess = [
        discordDesktopAccessStatus(discordDesktopState),
        desktopBrowserAccessStatus({
          active: workspaceAvailable,
          available: workspaceAvailable,
          probe: workspaceProbe,
          hasTab: Boolean(workspaceTabId),
        }),
      ];
      const desktopProbe = discordDesktopState.probe;
      const desktopDmInboxVisible = desktopProbe?.dmInbox.visible === true;
      const desktopConnected =
        desktopProbe?.loggedIn === true || desktopDmInboxVisible;
      if (discordDesktopState.cdpAvailable) {
        const capabilities =
          desktopConnected || desktopProbe?.dmInbox.visible
            ? FULL_DISCORD_CAPABILITIES
            : normalizeDiscordCapabilities(grant?.capabilities);
        const identity = identityFromProbe(
          desktopProbe,
          grant?.identity ?? null,
        );
        const statusGrant = desktopConnected
          ? await this.lifeOpsDiscordUpsertGrantForActiveSession({
              side: normalizedSide,
              grant,
              identity: identity ?? {},
              capabilities,
              metadata: {
                source: "discord_desktop",
                cdpPort: discordDesktopState.port,
                tabId: workspaceTabId,
                sessionId: null,
                companionId: null,
              },
            })
          : grant;
        return {
          provider: "discord",
          side: normalizedSide,
          available: true,
          connected: desktopConnected,
          reason: discordDesktopReasonFor({
            available: true,
            loggedIn: desktopConnected,
            hasGrant: Boolean(grant),
            hasDiscordTarget: Boolean(discordDesktopState.targetUrl),
          }),
          identity,
          dmInbox: desktopProbe?.dmInbox ?? emptyDiscordDmInboxProbe(),
          grantedCapabilities: capabilities,
          lastError: discordDesktopState.lastError,
          tabId: tabIdFromGrant(grant),
          browserAccess,
          grant: statusGrant,
        };
      }
      const workspaceStatus = await this.lifeOpsDiscordBuildWorkspaceStatus(
        normalizedSide,
        grant,
      );
      return {
        ...workspaceStatus,
        browserAccess,
      };
    }

    return this.lifeOpsDiscordBuildWorkspaceStatus(normalizedSide, grant);
  }

  /**
   * Open or focus Discord through the owner browser path so LifeOps can
   * verify login state and DM visibility through Discord Desktop or the browser workspace.
   */
  async authorizeDiscordConnector(
    side?: LifeOpsConnectorSide,
    source?: LifeOpsOwnerBrowserAccessSource,
  ): Promise<LifeOpsDiscordConnectorStatus> {
    const normalizedSide =
      normalizeOptionalConnectorSide(side, "side") ?? "owner";
    if (normalizedSide === "agent") {
      return this.getDiscordConnectorStatus(normalizedSide);
    }

    const existing = await this.ctx.repository.getConnectorGrant(
      this.ctx.agentId(),
      "discord",
      "local",
      normalizedSide,
    );

    if (source === "lifeops_browser") {
      throw new ElizaError(
        "The companion extension has been retired. Choose Discord Desktop or the browser workspace.",
        {
          code: "BROWSER_COMPANION_RETIRED",
        },
      );
    }
    if (source === "discord_desktop") {
      if (normalizedSide !== "owner") {
        fail(
          400,
          "Discord Desktop control is only available for the owner side.",
        );
      }
      const state = await relaunchDiscordDesktopForCdp();
      const probe = state.probe;
      const loggedIn = probe?.loggedIn === true;
      const capabilities =
        loggedIn || probe?.dmInbox.visible
          ? FULL_DISCORD_CAPABILITIES
          : (existing?.capabilities ?? []);
      const identity =
        identityFromProbe(probe, existing?.identity ?? null) ?? {};
      const metadata = {
        ...(existing?.metadata ?? {}),
        source: "discord_desktop",
        cdpPort: state.port,
        tabId: tabIdFromGrant(existing),
        sessionId: null,
        companionId: null,
      };

      const grant = existing
        ? {
            ...existing,
            identity,
            capabilities,
            metadata,
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: this.ctx.agentId(),
            provider: "discord",
            identity,
            grantedScopes: [],
            capabilities,
            tokenRef: null,
            mode: "local",
            side: normalizedSide,
            metadata,
            lastRefreshAt: new Date().toISOString(),
          });

      await this.ctx.repository.upsertConnectorGrant(grant);
      await this.ctx.recordConnectorAudit(
        `discord:${normalizedSide}`,
        "discord desktop connector authorized",
        { side: normalizedSide },
        {
          cdpPort: state.port,
          loggedIn,
          targetUrl: state.targetUrl,
        },
      );

      return this.getDiscordConnectorStatus(normalizedSide);
    }

    if (!discordBrowserWorkspaceAvailable()) {
      fail(
        503,
        "Discord connector requires Discord Desktop or the Eliza browser workspace.",
      );
    }

    const sideAccountId = `${this.ctx.agentId()}-${normalizedSide}`;
    const { tabId } = await ensureDiscordTab({
      accountId: sideAccountId,
      existingTabId: tabIdFromGrant(existing),
      show: true,
    });

    const probe = await this.lifeOpsDiscordProbeTab(tabId);
    const loggedIn = probe?.loggedIn === true;
    const capabilities = loggedIn
      ? FULL_DISCORD_CAPABILITIES
      : (existing?.capabilities ?? []);
    const identity = identityFromProbe(probe, existing?.identity ?? null) ?? {};

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
          agentId: this.ctx.agentId(),
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

    await this.ctx.repository.upsertConnectorGrant(grant);
    await this.ctx.recordConnectorAudit(
      `discord:${normalizedSide}`,
      "discord browser connector authorized",
      { side: normalizedSide },
      { tabId, loggedIn },
    );

    return this.getDiscordConnectorStatus(normalizedSide);
  }

  /**
   * Search messages in Discord via browser-DOM eval. Requires a connected
   * browser companion or workspace tab. Uses Discord's native search — no
   * client-side filtering.
   *
   * Capability descriptor: `search: true`, `deliveryStatus: 'partial'`.
   */
  async searchDiscordMessages(request: {
    side?: LifeOpsConnectorSide;
    query: string;
    channelId?: string;
    limit?: number;
  }): Promise<DiscordMessageSearchResult[]> {
    const normalizedSide =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const status = await this.getDiscordConnectorStatus(normalizedSide);
    if (!status.connected) {
      fail(409, "Discord is not connected.");
    }
    if (!status.grantedCapabilities.includes("discord.read")) {
      fail(403, "Discord read capability is not granted.");
    }
    const delegated = await searchDiscordMessagesWithRuntimeService({
      runtime: this.ctx.runtime,
      grant: status.grant,
      query: request.query,
      channelId: request.channelId,
      limit: request.limit,
    });
    if (delegated.status === "handled") {
      return delegated.value.map(memoryToDiscordMessageSearchResult);
    }
    if (delegated.error) {
      this.ctx.logLifeOpsWarn(
        "runtime_service_delegation_unavailable",
        delegated.reason,
        {
          provider: "discord",
          operation: "message.search",
          error:
            delegated.error instanceof Error
              ? delegated.error.message
              : String(delegated.error),
        },
      );
    }
    if (normalizedSide === "agent") {
      fail(503, "Discord plugin search service is not available.");
    }
    const grant = await this.ctx.repository.getConnectorGrant(
      this.ctx.agentId(),
      "discord",
      "local",
      normalizedSide,
    );

    const tabId = tabIdFromGrant(grant);
    if (!tabId && !discordBrowserWorkspaceAvailable()) {
      fail(
        409,
        "Discord search requires a connected browser tab. Authorize the Discord connector first.",
      );
    }
    if (!tabId) {
      fail(
        409,
        "Discord search requires a connected workspace tab. Authorize the Discord connector first.",
      );
    }

    return searchDiscordMessages({
      tabId,
      query: request.query,
      channelId: request.channelId,
    });
  }

  /**
   * Capture delivery status for recently sent Discord messages visible in
   * the current channel. Partial coverage — only messages rendered in the
   * active Discord tab can be inspected.
   *
   * Capability descriptor: `deliveryStatus: 'partial'`.
   */
  async captureDiscordDeliveryStatus(
    side?: LifeOpsConnectorSide,
  ): Promise<DiscordMessageSearchResult[]> {
    const normalizedSide =
      normalizeOptionalConnectorSide(side, "side") ?? "owner";
    const grant = await this.ctx.repository.getConnectorGrant(
      this.ctx.agentId(),
      "discord",
      "local",
      normalizedSide,
    );

    const tabId = tabIdFromGrant(grant);
    if (!tabId) {
      fail(
        409,
        "Discord delivery status capture requires a connected workspace tab.",
      );
    }

    return captureDiscordDeliveryStatus({ tabId });
  }

  async sendDiscordMessage(request: {
    side?: LifeOpsConnectorSide;
    expectedIdentityId?: string;
    channelId?: string;
    /**
     * Discord user id target. Mutually exclusive with `channelId`; the
     * discord runtime service resolves the DM channel (`users.fetch` →
     * `createDM`), so callers addressing a person never guess a channel id.
     */
    userId?: string;
    text: string;
    allowTransportFallback?: boolean;
  }): Promise<DiscordSendMessageResult> {
    const normalizedSide =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    if (
      request.expectedIdentityId !== undefined &&
      (normalizedSide !== "agent" || request.userId)
    ) {
      throw new ConnectorSenderChangedError(
        "discord",
        request.expectedIdentityId,
        null,
      );
    }
    const text = request.text.trim();
    if (!text) {
      fail(400, "text is required");
    }
    const userId = request.userId?.trim();
    if (userId && request.channelId?.trim()) {
      fail(400, "channelId and userId are mutually exclusive send targets.");
    }

    const status = await this.getDiscordConnectorStatus(normalizedSide);
    if (!status.connected) {
      fail(409, "Discord is not connected.");
    }
    if (!status.grantedCapabilities.includes("discord.send")) {
      fail(403, "Discord send capability is not granted.");
    }

    if (userId) {
      // User-id targets resolve to a DM inside plugin-discord's send handler
      // (`target.entityId` → `users.fetch` → `createDM`). The desktop-CDP
      // transport cannot take this path — it navigates
      // `/channels/@me/<dm-channel-id>` and has no user→DM resolution — so
      // user-targeted sends always go through the runtime send handler.
      if (typeof this.ctx.runtime.sendMessageToTarget !== "function") {
        fail(503, "Discord send handler is not available.");
      }
      const accountId = status.grant?.connectorAccountId ?? "default";
      // TargetInfo types `entityId` as a runtime UUID, but plugin-discord's
      // handler explicitly also accepts a raw Discord snowflake there
      // (normalizeDiscordTargetUserId) — same cast the runtime-service
      // delegates use for connector platform ids.
      const target: TargetInfo = {
        source: "discord",
        accountId,
        entityId: userId,
      } as TargetInfo;
      const delivery = requireConfirmedSendHandlerDelivery(
        await this.ctx.runtime.sendMessageToTarget(target, {
          text,
          source: "lifeops",
          metadata: { accountId },
        }),
      );
      return {
        provider: "discord",
        side: normalizedSide,
        userId,
        ok: true,
        // Confirmed-delivered disposition from the send handler; the CDP tab
        // capture below observes the owner's client, not the bot DM.
        deliveryStatus: "sent",
        providerMessageId: delivery.providerMessageId ?? null,
        receipt: delivery.receipt ?? null,
      };
    }

    const channelId =
      request.channelId?.trim() || selectedDiscordChannelIdFromStatus(status);
    if (!channelId) {
      fail(
        400,
        "channelId is required because no active Discord channel or DM is selected.",
      );
    }
    // Local-execution grants (Discord Desktop via CDP) drive the user's
    // own Discord client through CDP instead of the bot REST API. This is
    // necessary because Discord bots cannot DM users they don't share a
    // server with, so the bot path returns "Missing Access" for the DMs
    // the LifeOps inbox surfaces. CDP send appears to recipients as the
    // user's own message, matching the same trust model as reads.
    const grantMetadata =
      status.grant?.metadata && typeof status.grant.metadata === "object"
        ? (status.grant.metadata as Record<string, unknown>)
        : {};
    const useDiscordDesktopCdp =
      status.grant?.executionTarget === "local" &&
      (grantMetadata.source === "discord_desktop" || !status.tabId);
    let confirmedDelivery: ReturnType<
      typeof requireConfirmedSendHandlerDelivery
    > | null = null;
    if (useDiscordDesktopCdp) {
      const result = await sendDiscordViaDesktopCdp({ channelId, text });
      if (!result.ok) {
        fail(502, result.error ?? "Discord Desktop send failed.");
      }
    } else {
      const delegated = await sendDiscordMessageWithRuntimeService({
        runtime: this.ctx.runtime,
        expectedIdentityId: request.expectedIdentityId,
        grant: status.grant,
        channelId,
        text,
      });
      if (delegated.status !== "handled") {
        if (
          delegated.error instanceof ConnectorDeliveryEvidenceError ||
          delegated.error instanceof ConnectorSenderChangedError
        )
          throw delegated.error;
        if (delegated.error) {
          this.ctx.logLifeOpsWarn(
            "runtime_service_delegation_unavailable",
            delegated.reason,
            {
              provider: "discord",
              operation: "message.send",
              error:
                delegated.error instanceof Error
                  ? delegated.error.message
                  : String(delegated.error),
            },
          );
        }
        if (request.allowTransportFallback === false) {
          fail(503, "The selected Discord send transport is unavailable.");
        }
        if (typeof this.ctx.runtime.sendMessageToTarget !== "function") {
          fail(503, "Discord send handler is not available.");
        }
        const accountId = status.grant?.connectorAccountId ?? "default";
        confirmedDelivery = requireConfirmedSendHandlerDelivery(
          await this.ctx.runtime.sendMessageToTarget(
            { source: "discord", accountId, channelId },
            { text, source: "lifeops", metadata: { accountId } },
          ),
        );
      } else {
        confirmedDelivery = delegated.value.delivery;
      }
    }

    let deliveryStatus: "sent" | "sending" | "failed" | "unknown" =
      confirmedDelivery ? "sent" : "unknown";
    if (!confirmedDelivery && status.tabId) {
      await sleep(DISCORD_SEND_SETTLE_MS);
      const delivery = await captureDiscordDeliveryStatus({
        tabId: status.tabId,
      });
      const sent = delivery.find((item) => item.content.includes(text));
      deliveryStatus = sent?.deliveryStatus ?? deliveryStatus;
    }

    return {
      provider: "discord",
      side: normalizedSide,
      channelId,
      ok: true,
      deliveryStatus,
      providerMessageId: confirmedDelivery?.providerMessageId ?? null,
      receipt: confirmedDelivery?.receipt ?? null,
    };
  }

  async verifyDiscordConnector(request: {
    side?: LifeOpsConnectorSide;
    channelId?: string;
    sendMessage?: string;
  }): Promise<DiscordConnectorVerification> {
    if (request.channelId !== undefined || request.sendMessage !== undefined) {
      fail(
        400,
        "Discord verification is read-only. Draft a message and obtain owner approval before testing outbound delivery.",
      );
    }
    const normalizedSide =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const status = await this.getDiscordConnectorStatus(normalizedSide);

    return {
      provider: "discord",
      side: normalizedSide,
      verifiedAt: new Date().toISOString(),
      status,
      send: {
        attempted: false,
        ok: false,
        error:
          "Outbound verification requires a drafted message and explicit owner approval.",
        channelId: null,
        message: "",
        deliveryStatus: null,
      },
    };
  }

  async disconnectDiscord(
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsDiscordConnectorStatus> {
    const normalizedSide =
      normalizeOptionalConnectorSide(side, "side") ?? "owner";
    if (normalizedSide === "agent") {
      fail(
        409,
        "Agent-side Discord is owned by @elizaos/plugin-discord. Disable or reconfigure the Discord bot connector instead of deleting a LifeOps grant.",
      );
    }
    const grant = await this.ctx.repository.getConnectorGrant(
      this.ctx.agentId(),
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

    await this.ctx.repository.deleteConnectorGrant(
      this.ctx.agentId(),
      "discord",
      "local",
      normalizedSide,
    );

    await this.ctx.recordConnectorAudit(
      `discord:${normalizedSide}`,
      "discord browser connector disconnected",
      { side: normalizedSide },
      {},
    );

    return this.getDiscordConnectorStatus(normalizedSide);
  }
}

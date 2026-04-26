// @ts-nocheck — mixin: type safety is enforced on the composed class

import { logger } from "@elizaos/core";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeTabSummary,
} from "@elizaos/plugin-browser-bridge";
import type {
  LifeOpsBrowserSession,
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
} from "@elizaos/shared/contracts/lifeops";
import {
  capabilitiesForSide,
  LIFEOPS_DISCORD_CAPABILITIES,
} from "@elizaos/shared/contracts/lifeops";
import { asRecord } from "@elizaos/shared/type-guards";
import {
  captureDiscordDeliveryStatus,
  closeDiscordTab,
  DISCORD_APP_URL,
  type DiscordMessageSearchResult,
  type DiscordTabProbe,
  discordBrowserWorkspaceAvailable,
  emptyDiscordDmInboxProbe,
  ensureDiscordTab,
  probeDiscordCapturedPage,
  probeDiscordTab,
  searchDiscordMessages,
} from "./discord-browser-scraper.js";
import {
  type DiscordDesktopCdpStatus,
  getDiscordDesktopCdpStatus,
  relaunchDiscordDesktopForCdp,
} from "./discord-desktop-cdp.js";
import { createLifeOpsConnectorGrant } from "./repository.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import { normalizeOptionalConnectorSide } from "./service-normalize-connector.js";

const DISCORD_CONNECTOR_SESSION_TITLE = "Open Discord for LifeOps";

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

function browserReasonFor(args: {
  available: boolean;
  loggedIn: boolean;
  authPending: boolean;
  inProgress: boolean;
  hasGrant: boolean;
  hasDiscordTab: boolean;
}): LifeOpsMessagingConnectorReason {
  if (!args.available) return "disconnected";
  if (args.loggedIn) return "connected";
  if (args.authPending) return "auth_pending";
  if (args.inProgress || args.hasDiscordTab || args.hasGrant) return "pairing";
  return "disconnected";
}

function tabIdFromGrant(grant: LifeOpsConnectorGrant | null): string | null {
  if (!grant) return null;
  const raw = (grant.metadata as Record<string, unknown> | undefined)?.tabId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function sessionIdFromGrant(
  grant: LifeOpsConnectorGrant | null,
): string | null {
  if (!grant) return null;
  const raw = (grant.metadata as Record<string, unknown> | undefined)
    ?.sessionId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function companionIdFromGrant(
  grant: LifeOpsConnectorGrant | null,
): string | null {
  if (!grant) return null;
  const raw = (grant.metadata as Record<string, unknown> | undefined)
    ?.companionId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function companionKey(args: { browser: string; profileId: string }): string {
  return `${args.browser}:${args.profileId}`;
}

function companionMap(
  companions: readonly BrowserBridgeCompanionStatus[],
): Map<string, BrowserBridgeCompanionStatus> {
  return new Map(
    companions.map((companion) => [
      companionKey({
        browser: companion.browser,
        profileId: companion.profileId,
      }),
      companion,
    ]),
  );
}

function sortCompanionsByRecency(
  companions: readonly BrowserBridgeCompanionStatus[],
): BrowserBridgeCompanionStatus[] {
  return [...companions].sort((left, right) => {
    const leftMs = Date.parse(left.lastSeenAt ?? "");
    const rightMs = Date.parse(right.lastSeenAt ?? "");
    if (
      Number.isFinite(leftMs) &&
      Number.isFinite(rightMs) &&
      leftMs !== rightMs
    ) {
      return rightMs - leftMs;
    }
    if (
      left.lastSeenAt &&
      right.lastSeenAt &&
      left.lastSeenAt !== right.lastSeenAt
    ) {
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    }
    return left.id.localeCompare(right.id);
  });
}

function pickNewestDiscordTab(
  tabs: readonly BrowserBridgeTabSummary[],
): BrowserBridgeTabSummary | null {
  return (
    [...tabs]
      .filter((tab) => tab.url.includes("discord.com"))
      .sort((left, right) => {
        if (left.focusedActive !== right.focusedActive) {
          return left.focusedActive ? -1 : 1;
        }
        if (left.activeInWindow !== right.activeInWindow) {
          return left.activeInWindow ? -1 : 1;
        }
        const leftMs = Date.parse(left.lastFocusedAt ?? left.lastSeenAt);
        const rightMs = Date.parse(right.lastFocusedAt ?? right.lastSeenAt);
        if (
          Number.isFinite(leftMs) &&
          Number.isFinite(rightMs) &&
          leftMs !== rightMs
        ) {
          return rightMs - leftMs;
        }
        return right.lastSeenAt.localeCompare(left.lastSeenAt);
      })[0] ?? null
  );
}

function parseSessionProbe(
  session: LifeOpsBrowserSession | null,
): DiscordTabProbe | null {
  if (!session) return null;
  const result = asRecord(session.result);
  if (!result) return null;
  const actionResults = asRecord(result.actionResults) ?? result;
  let pageUrl: string | null = null;
  let pageTitle: string | null = null;
  let mainText: string | null = null;
  let links: Array<{ text: string; href: string }> = [];
  let forms: Array<{ action: string | null; fields: string[] }> = [];

  for (const action of session.actions) {
    const entry = asRecord(actionResults[action.id]);
    if (!entry) continue;
    if (action.kind === "open") {
      pageUrl =
        typeof entry.openedUrl === "string" && entry.openedUrl.length > 0
          ? entry.openedUrl
          : pageUrl;
    } else if (action.kind === "navigate") {
      pageUrl =
        typeof entry.navigatedUrl === "string" && entry.navigatedUrl.length > 0
          ? entry.navigatedUrl
          : pageUrl;
    } else if (action.kind === "read_page") {
      pageUrl =
        typeof entry.url === "string" && entry.url.length > 0
          ? entry.url
          : pageUrl;
      pageTitle =
        typeof entry.title === "string" && entry.title.length > 0
          ? entry.title
          : pageTitle;
      mainText =
        typeof entry.mainText === "string" && entry.mainText.length > 0
          ? entry.mainText
          : mainText;
    } else if (action.kind === "extract_links") {
      const candidateLinks = Array.isArray(entry.links) ? entry.links : [];
      links = candidateLinks.filter(
        (candidate): candidate is { text: string; href: string } =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          typeof (candidate as { href?: unknown }).href === "string" &&
          typeof (candidate as { text?: unknown }).text === "string",
      );
    } else if (action.kind === "extract_forms") {
      const candidateForms = Array.isArray(entry.forms) ? entry.forms : [];
      forms = candidateForms.filter(
        (candidate): candidate is { action: string | null; fields: string[] } =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          Array.isArray((candidate as { fields?: unknown }).fields),
      );
    }
  }

  if (!pageUrl) return null;
  return probeDiscordCapturedPage({
    url: pageUrl,
    title: pageTitle,
    mainText,
    links,
    forms,
  });
}

function sessionError(session: LifeOpsBrowserSession | null): string | null {
  if (!session || session.status !== "failed") return null;
  const result = asRecord(session.result);
  const error = result?.error;
  return typeof error === "string" && error.trim().length > 0
    ? error.trim()
    : null;
}

function siteAccessAllowsDiscord(
  companion: BrowserBridgeCompanionStatus | null,
  hasDiscordPage: boolean,
): boolean | null {
  if (!companion) {
    return null;
  }
  if (hasDiscordPage) {
    return true;
  }
  if (companion.permissions.allOrigins) {
    return true;
  }
  return companion.permissions.grantedOrigins.some((origin) =>
    origin.includes("discord.com"),
  );
}

function browserAuthStateFromProbe(
  probe: DiscordTabProbe | null,
): LifeOpsOwnerBrowserAuthState {
  if (probe?.loggedIn === true) {
    return "logged_in";
  }
  if (
    probe?.loggedIn === false &&
    Boolean(probe.url?.includes("discord.com"))
  ) {
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
  if (args.probe?.url?.includes("discord.com")) {
    return "discord_open";
  }
  if (args.hasDiscordTab) {
    return "background_discord";
  }
  return "missing";
}

function browserBridgeAccessStatus(args: {
  active: boolean;
  settingsEnabled: boolean;
  trackingEnabled: boolean;
  paused: boolean;
  canControl: boolean;
  companion: BrowserBridgeCompanionStatus | null;
  hasAnyCompanion: boolean;
  hasConnectedCompanion: boolean;
  probe: DiscordTabProbe | null;
  hasDiscordTab: boolean;
  siteAccessOk: boolean | null;
}): LifeOpsOwnerBrowserAccessStatus {
  const authState = browserAuthStateFromProbe(args.probe);
  const tabState = browserTabState({
    probe: args.probe,
    hasDiscordTab: args.hasDiscordTab,
  });

  let nextAction: LifeOpsOwnerBrowserNextAction = "none";

  if (!args.settingsEnabled || !args.trackingEnabled || args.paused) {
    nextAction = "enable_browser_access";
  } else if (!args.hasAnyCompanion) {
    nextAction = "connect_browser";
  } else if (!args.hasConnectedCompanion) {
    nextAction = "open_extension_popup";
  } else if (authState === "logged_out") {
    nextAction = "log_in";
  } else if (!args.canControl && tabState === "missing") {
    nextAction = "enable_browser_control";
  } else if (!args.canControl && tabState !== "dm_inbox_visible") {
    nextAction = "focus_dm_inbox_manually";
  } else if (tabState === "missing") {
    nextAction = "open_discord";
  } else if (authState === "logged_in" && tabState !== "dm_inbox_visible") {
    nextAction = "open_dm_inbox";
  }

  if (args.siteAccessOk === false && nextAction === "none") {
    nextAction = "open_discord";
  }

  return {
    source: "lifeops_browser",
    active: args.active,
    available:
      args.settingsEnabled &&
      args.trackingEnabled &&
      !args.paused &&
      args.hasConnectedCompanion,
    browser: args.companion?.browser ?? null,
    profileId: args.companion?.profileId ?? null,
    profileLabel: args.companion?.profileLabel ?? null,
    companionId: args.companion?.id ?? null,
    companionLabel: args.companion?.label ?? null,
    canControl: args.canControl,
    siteAccessOk: args.siteAccessOk,
    currentUrl: args.probe?.url ?? null,
    tabState,
    authState,
    nextAction,
  };
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
      Boolean(state.targetUrl?.includes("discord.com")) || state.cdpAvailable,
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

/** @internal */
export function withDiscord<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsDiscordServiceMixin extends Base {
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
        return await this.getBrowserSession(sessionId);
      } catch {
        return null;
      }
    }

    async lifeOpsDiscordGetOwnerBrowserDiscordState(
      grant: LifeOpsConnectorGrant | null,
    ): Promise<{
      available: boolean;
      settingsEnabled: boolean;
      trackingEnabled: boolean;
      paused: boolean;
      canControl: boolean;
      selectedCompanion: BrowserBridgeCompanionStatus | null;
      hasAnyCompanion: boolean;
      hasConnectedCompanion: boolean;
      discordTab: BrowserBridgeTabSummary | null;
      currentPageUrl: string | null;
      probe: DiscordTabProbe | null;
      session: LifeOpsBrowserSession | null;
      lastError: string | null;
      reason: LifeOpsMessagingConnectorReason;
    }> {
      const settings = await this.getBrowserSettings();
      const allCompanions = sortCompanionsByRecency(
        await this.listBrowserCompanions(),
      );
      const connectedCompanions = allCompanions.filter(
        (companion) => companion.connectionState === "connected",
      );
      const paused = this.isBrowserPaused(settings);
      const trackingEnabled = settings.trackingMode !== "off";
      const settingsEnabled = settings.enabled;

      const available =
        settingsEnabled &&
        trackingEnabled &&
        !paused &&
        connectedCompanions.length > 0;

      const tabs = await this.listBrowserTabs();
      const currentPage = await this.getCurrentBrowserPage();
      const currentPageProbe = currentPage?.url.includes("discord.com")
        ? probeDiscordCapturedPage(currentPage)
        : null;
      const discordTab = pickNewestDiscordTab(tabs);
      const session = await this.lifeOpsDiscordGetBrowserSessionById(
        sessionIdFromGrant(grant),
      );
      const sessionProbe = parseSessionProbe(session);
      const probe =
        currentPageProbe ??
        (discordTab &&
        (session?.status === "done" ||
          session?.status === "queued" ||
          session?.status === "running" ||
          session?.status === "awaiting_confirmation")
          ? sessionProbe
          : null);
      const companionByKey = companionMap(connectedCompanions);
      const selectedCompanion =
        (currentPage &&
          companionByKey.get(
            companionKey({
              browser: currentPage.browser,
              profileId: currentPage.profileId,
            }),
          )) ??
        (discordTab &&
          companionByKey.get(
            companionKey({
              browser: discordTab.browser,
              profileId: discordTab.profileId,
            }),
          )) ??
        (companionIdFromGrant(grant)
          ? (connectedCompanions.find(
              (companion) => companion.id === companionIdFromGrant(grant),
            ) ?? null)
          : null) ??
        connectedCompanions[0] ??
        (companionIdFromGrant(grant)
          ? (allCompanions.find(
              (companion) => companion.id === companionIdFromGrant(grant),
            ) ?? null)
          : null) ??
        allCompanions[0] ??
        null;

      const reason = browserReasonFor({
        available,
        loggedIn: probe?.loggedIn === true,
        authPending:
          probe?.loggedIn === false &&
          Boolean(probe.url?.includes("discord.com")),
        inProgress:
          session?.status === "queued" ||
          session?.status === "running" ||
          session?.status === "awaiting_confirmation",
        hasGrant: Boolean(grant),
        hasDiscordTab: Boolean(discordTab),
      });

      return {
        available,
        settingsEnabled,
        trackingEnabled,
        paused,
        canControl: settings.allowBrowserControl,
        selectedCompanion,
        hasAnyCompanion: allCompanions.length > 0,
        hasConnectedCompanion: connectedCompanions.length > 0,
        discordTab,
        currentPageUrl: currentPage?.url ?? null,
        probe,
        session,
        lastError: sessionError(session),
        reason,
      };
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
          ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
          : (grant?.capabilities ?? []).filter(
              (candidate): candidate is LifeOpsDiscordCapability =>
                candidate === "discord.read" || candidate === "discord.send",
            );

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
        identity: identityFromProbe(probe, grant?.identity ?? null),
        dmInbox: probe?.dmInbox ?? emptyDiscordDmInboxProbe(),
        grantedCapabilities: capabilities,
        lastError: null,
        tabId,
        browserAccess,
        grant,
      };
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
      if (normalizedSide === "owner" && source !== "desktop_browser") {
        const browserState =
          await this.lifeOpsDiscordGetOwnerBrowserDiscordState(grant);
        const discordDesktopState = await getDiscordDesktopCdpStatus();
        const workspaceAvailable = discordBrowserWorkspaceAvailable();
        const workspaceTabId = tabIdFromGrant(grant);
        const workspaceProbe = workspaceAvailable
          ? await this.lifeOpsDiscordProbeTab(workspaceTabId)
          : null;
        const probe = browserState.probe;
        const connected = probe?.loggedIn === true;
        const onDiscordPage =
          Boolean(browserState.currentPageUrl?.includes("discord.com")) ||
          Boolean(browserState.discordTab);
        const browserAccess = [
          discordDesktopAccessStatus(discordDesktopState),
          browserBridgeAccessStatus({
            active: browserState.available,
            settingsEnabled: browserState.settingsEnabled,
            trackingEnabled: browserState.trackingEnabled,
            paused: browserState.paused,
            canControl: browserState.canControl,
            companion: browserState.selectedCompanion,
            hasAnyCompanion: browserState.hasAnyCompanion,
            hasConnectedCompanion: browserState.hasConnectedCompanion,
            probe,
            hasDiscordTab: onDiscordPage,
            siteAccessOk: siteAccessAllowsDiscord(
              browserState.selectedCompanion,
              onDiscordPage || Boolean(browserState.discordTab),
            ),
          }),
          desktopBrowserAccessStatus({
            active: !browserState.available && workspaceAvailable,
            available: workspaceAvailable,
            probe: workspaceProbe,
            hasTab: Boolean(workspaceTabId),
          }),
        ];
        if (!browserState.available && discordDesktopState.cdpAvailable) {
          const desktopProbe = discordDesktopState.probe;
          const desktopConnected = desktopProbe?.loggedIn === true;
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
            identity: identityFromProbe(desktopProbe, grant?.identity ?? null),
            dmInbox: desktopProbe?.dmInbox ?? emptyDiscordDmInboxProbe(),
            grantedCapabilities:
              desktopConnected || desktopProbe?.dmInbox.visible
                ? capabilitiesForSide(
                    LIFEOPS_DISCORD_CAPABILITIES,
                    normalizedSide,
                  )
                : (grant?.capabilities ?? []),
            lastError: discordDesktopState.lastError,
            tabId: tabIdFromGrant(grant),
            browserAccess,
            grant,
          };
        }
        if (browserState.available) {
          return {
            provider: "discord",
            side: normalizedSide,
            available: true,
            connected,
            reason: browserState.reason,
            identity: identityFromProbe(probe, grant?.identity ?? null),
            dmInbox: probe?.dmInbox ?? emptyDiscordDmInboxProbe(),
            grantedCapabilities:
              connected || probe?.dmInbox.visible
                ? capabilitiesForSide(
                    LIFEOPS_DISCORD_CAPABILITIES,
                    normalizedSide,
                  )
                : [],
            lastError: browserState.lastError,
            tabId: tabIdFromGrant(grant),
            browserAccess,
            grant,
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
     * verify login state and DM visibility, falling back to the desktop
     * browser workspace when no browser companion is connected.
     */
    async authorizeDiscordConnector(
      side?: LifeOpsConnectorSide,
      source?: LifeOpsOwnerBrowserAccessSource,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );

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
            ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
            : (existing?.capabilities ?? []);
        const identity =
          identityFromProbe(probe, existing?.identity ?? null) ?? {};
        const metadata = {
          ...(existing?.metadata ?? {}),
          source: "discord_desktop",
          cdpPort: state.port,
          tabId: null,
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
              agentId: this.agentId(),
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

        await this.repository.upsertConnectorGrant(grant);
        await this.recordConnectorAudit(
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

      if (normalizedSide === "owner") {
        const browserState =
          await this.lifeOpsDiscordGetOwnerBrowserDiscordState(existing);
        const hasConnectedBrowserPath =
          browserState.hasConnectedCompanion ||
          Boolean(browserState.currentPageUrl?.includes("discord.com")) ||
          Boolean(browserState.discordTab) ||
          Boolean(browserState.probe);
        if (hasConnectedBrowserPath) {
          const probe = browserState.probe;
          const connected = probe?.loggedIn === true;
          const dmInboxVisible = probe?.dmInbox.visible === true;
          const identity =
            identityFromProbe(probe, existing?.identity ?? null) ?? {};
          const onDiscordPage = Boolean(probe?.url?.includes("discord.com"));
          const onDiscordDmPage = Boolean(
            probe?.url?.includes("/channels/@me"),
          );
          const needsDiscordOpen = !connected && !onDiscordPage;
          const needsDmInspection = connected && !dmInboxVisible;

          if (
            !browserState.canControl &&
            !browserState.discordTab &&
            !onDiscordPage
          ) {
            fail(
              409,
              "Agent Browser Bridge can see your browser, but browser control is disabled. Enable browser control or open Discord manually, then try again.",
            );
          }

          let sessionId = sessionIdFromGrant(existing);
          let companionId = companionIdFromGrant(existing);

          if (needsDiscordOpen || needsDmInspection) {
            if (browserState.discordTab) {
              if (!browserState.canControl && !onDiscordDmPage) {
                fail(
                  409,
                  "Discord is open in your browser, but Agent Browser Bridge control is disabled. Focus the Discord DM tab manually or enable browser control.",
                );
              }
            }

            if (!browserState.selectedCompanion) {
              fail(
                503,
                "No connected Agent Browser Bridge companion is available for Discord.",
              );
            }
            if (!browserState.canControl) {
              fail(
                409,
                "Agent Browser Bridge control is disabled. Enable browser control or open Discord manually so LifeOps can inspect your DMs.",
              );
            }

            const session = await this.createBrowserSession({
              browser: browserState.selectedCompanion.browser,
              companionId: browserState.selectedCompanion.id,
              profileId: browserState.selectedCompanion.profileId,
              tabId: browserState.discordTab?.tabId ?? null,
              windowId: browserState.discordTab?.windowId ?? null,
              title: DISCORD_CONNECTOR_SESSION_TITLE,
              actions: [
                browserState.discordTab
                  ? {
                      kind: "focus_tab",
                      label: "Focus Discord tab",
                      browser: browserState.selectedCompanion.browser,
                      url: browserState.discordTab.url,
                      tabId: browserState.discordTab.tabId,
                      selector: null,
                      text: null,
                      accountAffecting: false,
                      requiresConfirmation: false,
                      metadata: {},
                    }
                  : {
                      kind: "open",
                      label: "Open Discord",
                      browser: browserState.selectedCompanion.browser,
                      url: DISCORD_APP_URL,
                      tabId: null,
                      selector: null,
                      text: null,
                      accountAffecting: false,
                      requiresConfirmation: false,
                      metadata: {},
                    },
                ...(browserState.discordTab
                  ? [
                      {
                        kind: "navigate" as const,
                        label: "Open Discord DMs",
                        browser: browserState.selectedCompanion.browser,
                        url: DISCORD_APP_URL,
                        tabId: browserState.discordTab.tabId,
                        selector: null,
                        text: null,
                        accountAffecting: false,
                        requiresConfirmation: false,
                        metadata: {},
                      },
                    ]
                  : []),
                {
                  kind: "read_page",
                  label: "Read Discord page",
                  browser: browserState.selectedCompanion.browser,
                  url: DISCORD_APP_URL,
                  tabId: null,
                  selector: null,
                  text: null,
                  accountAffecting: false,
                  requiresConfirmation: false,
                  metadata: {},
                },
                {
                  kind: "extract_links",
                  label: "Extract Discord links",
                  browser: browserState.selectedCompanion.browser,
                  url: DISCORD_APP_URL,
                  tabId: null,
                  selector: null,
                  text: null,
                  accountAffecting: false,
                  requiresConfirmation: false,
                  metadata: {},
                },
                {
                  kind: "extract_forms",
                  label: "Inspect Discord login state",
                  browser: browserState.selectedCompanion.browser,
                  url: DISCORD_APP_URL,
                  tabId: null,
                  selector: null,
                  text: null,
                  accountAffecting: false,
                  requiresConfirmation: false,
                  metadata: {},
                },
              ],
            });
            sessionId = session.id;
            companionId = browserState.selectedCompanion.id;
          }

          const capabilities =
            connected && dmInboxVisible
              ? capabilitiesForSide(
                  LIFEOPS_DISCORD_CAPABILITIES,
                  normalizedSide,
                )
              : (existing?.capabilities ?? []);
          const metadata = {
            ...(existing?.metadata ?? {}),
            tabId: null,
            sessionId,
            companionId,
            browser: browserState.selectedCompanion?.browser ?? null,
            profileId: browserState.selectedCompanion?.profileId ?? null,
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
                agentId: this.agentId(),
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

          await this.repository.upsertConnectorGrant(grant);
          await this.recordConnectorAudit(
            `discord:${normalizedSide}`,
            "discord browser companion connector authorized",
            { side: normalizedSide },
            {
              companionId,
              sessionId,
              loggedIn: connected,
            },
          );

          return this.getDiscordConnectorStatus(normalizedSide);
        }
      }

      if (!discordBrowserWorkspaceAvailable()) {
        fail(
          503,
          "Discord connector requires either Your Browser connected through Agent Browser Bridge or Milady Desktop Browser.",
        );
      }

      const { tabId } = await ensureDiscordTab({
        agentId: this.agentId(),
        side: normalizedSide,
        existingTabId: tabIdFromGrant(existing),
        show: true,
      });

      const probe = await this.lifeOpsDiscordProbeTab(tabId);
      const loggedIn = probe?.loggedIn === true;
      const capabilities = loggedIn
        ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
        : (existing?.capabilities ?? []);
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
    }): Promise<DiscordMessageSearchResult[]> {
      const normalizedSide =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
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
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
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

      return this.getDiscordConnectorStatus(normalizedSide);
    }
  }

  return LifeOpsDiscordServiceMixin;
}

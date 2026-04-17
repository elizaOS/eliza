// @ts-nocheck — mixin: type safety is enforced on the composed class

import { logger } from "@elizaos/core";
import type {
  LifeOpsBrowserCompanionStatus,
  LifeOpsBrowserSession,
  LifeOpsBrowserTabSummary,
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsDiscordCapability,
  LifeOpsDiscordConnectorStatus,
  LifeOpsMessagingConnectorReason,
} from "@elizaos/shared/contracts/lifeops";
import {
  capabilitiesForSide,
  LIFEOPS_DISCORD_CAPABILITIES,
} from "@elizaos/shared/contracts/lifeops";
import {
  closeDiscordTab,
  DISCORD_APP_URL,
  type DiscordTabProbe,
  discordBrowserWorkspaceAvailable,
  emptyDiscordDmInboxProbe,
  ensureDiscordTab,
  probeDiscordCapturedPage,
  probeDiscordTab,
} from "./discord-browser-scraper.js";
import { createLifeOpsConnectorGrant } from "./repository.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import { normalizeOptionalConnectorSide } from "./service-normalize-connector.js";

const DISCORD_CONNECTOR_SESSION_TITLE = "Open Discord for LifeOps";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

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

function sessionIdFromGrant(grant: LifeOpsConnectorGrant | null): string | null {
  if (!grant) return null;
  const raw = (grant.metadata as Record<string, unknown> | undefined)?.sessionId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function companionIdFromGrant(grant: LifeOpsConnectorGrant | null): string | null {
  if (!grant) return null;
  const raw = (grant.metadata as Record<string, unknown> | undefined)?.companionId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function companionKey(args: { browser: string; profileId: string }): string {
  return `${args.browser}:${args.profileId}`;
}

function companionMap(
  companions: readonly LifeOpsBrowserCompanionStatus[],
): Map<string, LifeOpsBrowserCompanionStatus> {
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
  companions: readonly LifeOpsBrowserCompanionStatus[],
): LifeOpsBrowserCompanionStatus[] {
  return [...companions].sort((left, right) => {
    const leftMs = Date.parse(left.lastSeenAt ?? "");
    const rightMs = Date.parse(right.lastSeenAt ?? "");
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
      return rightMs - leftMs;
    }
    if (left.lastSeenAt && right.lastSeenAt && left.lastSeenAt !== right.lastSeenAt) {
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    }
    return left.id.localeCompare(right.id);
  });
}

function pickNewestDiscordTab(
  tabs: readonly LifeOpsBrowserTabSummary[],
): LifeOpsBrowserTabSummary | null {
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
        if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
          return rightMs - leftMs;
        }
        return right.lastSeenAt.localeCompare(left.lastSeenAt);
      })[0] ?? null
  );
}

function parseSessionProbe(session: LifeOpsBrowserSession | null): DiscordTabProbe | null {
  if (!session) return null;
  const result = asRecord(session.result);
  if (!result) return null;
  const actionResults =
    asRecord(result.actionResults) ??
    result;
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
        typeof entry.url === "string" && entry.url.length > 0 ? entry.url : pageUrl;
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
  return typeof error === "string" && error.trim().length > 0 ? error.trim() : null;
}

/** @internal */
export function withDiscord<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsDiscordServiceMixin extends Base {
    async #probeTab(
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

    async #getBrowserSessionById(
      sessionId: string | null,
    ): Promise<LifeOpsBrowserSession | null> {
      if (!sessionId) return null;
      try {
        return await this.getBrowserSession(sessionId);
      } catch {
        return null;
      }
    }

    async #getOwnerBrowserDiscordState(
      grant: LifeOpsConnectorGrant | null,
    ): Promise<{
      available: boolean;
      canControl: boolean;
      selectedCompanion: LifeOpsBrowserCompanionStatus | null;
      discordTab: LifeOpsBrowserTabSummary | null;
      probe: DiscordTabProbe | null;
      session: LifeOpsBrowserSession | null;
      lastError: string | null;
      reason: LifeOpsMessagingConnectorReason;
    } | null> {
      const settings = await this.getBrowserSettings();
      const connectedCompanions = sortCompanionsByRecency(
        (await this.listBrowserCompanions()).filter(
          (companion) => companion.connectionState === "connected",
        ),
      );

      const available =
        settings.enabled &&
        settings.trackingMode !== "off" &&
        !this.isBrowserPaused(settings) &&
        connectedCompanions.length > 0;
      if (!available) {
        return null;
      }

      const tabs = await this.listBrowserTabs();
      const currentPage = await this.getCurrentBrowserPage();
      const currentPageProbe =
        currentPage && currentPage.url.includes("discord.com")
          ? probeDiscordCapturedPage(currentPage)
          : null;
      const discordTab = pickNewestDiscordTab(tabs);
      const session = await this.#getBrowserSessionById(sessionIdFromGrant(grant));
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
          ? connectedCompanions.find(
              (companion) => companion.id === companionIdFromGrant(grant),
            ) ?? null
          : null) ??
        connectedCompanions[0] ??
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
        canControl: settings.allowBrowserControl,
        selectedCompanion,
        discordTab,
        probe,
        session,
        lastError: sessionError(session),
        reason,
      };
    }

    async #buildWorkspaceDiscordStatus(
      normalizedSide: LifeOpsConnectorSide,
      grant: LifeOpsConnectorGrant | null,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const available = discordBrowserWorkspaceAvailable();
      const tabId = tabIdFromGrant(grant);
      const probe = available ? await this.#probeTab(tabId) : null;
      const loggedIn = probe?.loggedIn === true;
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
      if (normalizedSide === "owner") {
        const browserState = await this.#getOwnerBrowserDiscordState(grant);
        if (browserState) {
          const probe = browserState.probe;
          const connected = probe?.loggedIn === true;
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
                ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
                : [],
            lastError: browserState.lastError,
            tabId: tabIdFromGrant(grant),
            grant,
          };
        }
      }

      return this.#buildWorkspaceDiscordStatus(normalizedSide, grant);
    }

    /**
     * Open or focus Discord through the owner browser path so LifeOps can
     * verify login state and DM visibility, falling back to the desktop
     * browser workspace when no browser companion is connected.
     */
    async authorizeDiscordConnector(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus> {
      const normalizedSide =
        normalizeOptionalConnectorSide(side, "side") ?? "owner";
      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "discord",
        "local",
        normalizedSide,
      );

      if (normalizedSide === "owner") {
        const browserState = await this.#getOwnerBrowserDiscordState(existing);
        if (browserState) {
          const probe = browserState.probe;
          const connected = probe?.loggedIn === true;
          const dmInboxVisible = probe?.dmInbox.visible === true;
          const identity =
            identityFromProbe(probe, existing?.identity ?? null) ?? {};
          const onDiscordPage = Boolean(
            probe?.url && probe.url.includes("discord.com"),
          );
          const onDiscordDmPage = Boolean(
            probe?.url && probe.url.includes("/channels/@me"),
          );
          const needsDiscordOpen = !connected && !onDiscordPage;
          const needsDmInspection = connected && !dmInboxVisible;

          if (!browserState.canControl && !browserState.discordTab && !onDiscordPage) {
            fail(
              409,
              "LifeOps Browser can see your browser, but browser control is disabled. Enable browser control or open Discord manually, then try again.",
            );
          }

          let sessionId = sessionIdFromGrant(existing);
          let companionId = companionIdFromGrant(existing);

          if (needsDiscordOpen || needsDmInspection) {
            if (browserState.discordTab) {
              if (!browserState.canControl && !onDiscordDmPage) {
                fail(
                  409,
                  "Discord is open in your browser, but LifeOps Browser control is disabled. Focus the Discord DM tab manually or enable browser control.",
                );
              }
            }

            if (!browserState.selectedCompanion) {
              fail(
                503,
                "No connected LifeOps Browser companion is available for Discord.",
              );
            }
            if (!browserState.canControl) {
              fail(
                409,
                "LifeOps Browser control is disabled. Enable browser control or open Discord manually so LifeOps can inspect your DMs.",
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

          const capabilities = connected && dmInboxVisible
            ? capabilitiesForSide(LIFEOPS_DISCORD_CAPABILITIES, normalizedSide)
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
          "Discord connector requires either a connected LifeOps Browser companion or the Milady desktop app browser workspace.",
        );
      }

      const { tabId } = await ensureDiscordTab({
        agentId: this.agentId(),
        side: normalizedSide,
        existingTabId: tabIdFromGrant(existing),
        show: true,
      });

      const probe = await this.#probeTab(tabId);
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
        available:
          normalizedSide === "owner"
            ? Boolean(await this.#getOwnerBrowserDiscordState(null)) ||
              discordBrowserWorkspaceAvailable()
            : discordBrowserWorkspaceAvailable(),
        connected: false,
        reason: "disconnected",
        identity: null,
        dmInbox: emptyDiscordDmInboxProbe(),
        grantedCapabilities: [],
        lastError: null,
        tabId: null,
        grant: null,
      };
    }
  }

  return LifeOpsDiscordServiceMixin;
}

import { describe, expect, test } from "vitest";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import { LifeOpsService, LifeOpsServiceError } from "../src/lifeops/service.js";
import { executeRawSql } from "../src/lifeops/sql.js";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.js";

async function createDiscordBrowserService(
  agentId: string,
): Promise<LifeOpsService> {
  const runtime = createLifeOpsChatTestRuntime({
    agentId,
    handleTurn: async () => ({ text: "ok" }),
    useModel: async () => {
      throw new Error(
        "useModel should not be called in Discord connector tests",
      );
    },
  });
  await LifeOpsRepository.bootstrapSchema(runtime);
  const service = new LifeOpsService(runtime);
  await service.updateBrowserSettings({
    enabled: true,
    allowBrowserControl: true,
  });
  return service;
}

async function syncBrowserCompanionState(
  service: LifeOpsService,
  args: {
    allowBrowserControl?: boolean;
    tabs: Array<{
      windowId: string;
      tabId: string;
      url: string;
      title: string;
      activeInWindow: boolean;
      focusedWindow: boolean;
      focusedActive: boolean;
    }>;
    pageContexts?: Array<{
      windowId: string;
      tabId: string;
      url: string;
      title: string;
      mainText?: string | null;
      links?: Array<{ text: string; href: string }>;
      forms?: Array<{ action: string | null; fields: string[] }>;
    }>;
  },
) {
  if (typeof args.allowBrowserControl === "boolean") {
    await service.updateBrowserSettings({
      enabled: true,
      allowBrowserControl: args.allowBrowserControl,
    });
  }

  await service.syncBrowserState({
    companion: {
      browser: "chrome",
      profileId: "profile-1",
      label: "LifeOps Browser Chrome",
      connectionState: "connected",
      permissions: {
        tabs: true,
        scripting: true,
        activeTab: true,
        allOrigins: true,
        grantedOrigins: ["https://discord.com"],
        incognitoEnabled: false,
      },
    },
    tabs: args.tabs.map((tab) => ({
      browser: "chrome" as const,
      profileId: "profile-1",
      windowId: tab.windowId,
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      activeInWindow: tab.activeInWindow,
      focusedWindow: tab.focusedWindow,
      focusedActive: tab.focusedActive,
    })),
    pageContexts: (args.pageContexts ?? []).map((page) => ({
      browser: "chrome" as const,
      profileId: "profile-1",
      windowId: page.windowId,
      tabId: page.tabId,
      url: page.url,
      title: page.title,
      mainText: page.mainText ?? null,
      links: page.links ?? [],
      forms: page.forms ?? [],
    })),
  });
}

async function recreateConnectorGrantsWithoutLogicalUnique(
  service: LifeOpsService,
): Promise<void> {
  await executeRawSql(service.runtime, "DROP TABLE life_connector_grants");
  await executeRawSql(
    service.runtime,
    `CREATE TABLE life_connector_grants (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'owner',
      identity_json TEXT NOT NULL DEFAULT '{}',
      identity_email TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      token_ref TEXT,
      mode TEXT NOT NULL DEFAULT 'oauth',
      execution_target TEXT NOT NULL DEFAULT 'local',
      source_of_truth TEXT NOT NULL DEFAULT 'local_storage',
      preferred_by_agent INTEGER NOT NULL DEFAULT 0,
      cloud_connection_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_refresh_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
}

describe("LifeOps Discord owner connector via browser companion", () => {
  test("upserts local connector grants on legacy tables without the logical unique constraint", async () => {
    const service = await createDiscordBrowserService(
      "lifeops-discord-browser-legacy-grants",
    );
    await recreateConnectorGrantsWithoutLogicalUnique(service);

    const timestamp = new Date().toISOString();
    const grant = createLifeOpsConnectorGrant({
      agentId: service.runtime.agentId,
      provider: "discord",
      identity: {},
      grantedScopes: [],
      capabilities: [],
      tokenRef: null,
      mode: "local",
      side: "owner",
      metadata: {
        sessionId: "session-1",
      },
      lastRefreshAt: timestamp,
    });

    await service.repository.upsertConnectorGrant(grant);
    await service.repository.upsertConnectorGrant({
      ...grant,
      metadata: {
        sessionId: "session-2",
      },
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });

    const grants = await service.repository.listConnectorGrants(
      service.runtime.agentId,
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      provider: "discord",
      mode: "local",
      metadata: {
        sessionId: "session-2",
      },
    });
  });

  test("reports connected and DM-visible when the focused browser page is Discord DMs", async () => {
    const service = await createDiscordBrowserService(
      "lifeops-discord-browser-focused",
    );

    await syncBrowserCompanionState(service, {
      tabs: [
        {
          windowId: "win-1",
          tabId: "discord-tab",
          url: "https://discord.com/channels/@me/222",
          title: "Discord",
          activeInWindow: true,
          focusedWindow: true,
          focusedActive: true,
        },
      ],
      pageContexts: [
        {
          windowId: "win-1",
          tabId: "discord-tab",
          url: "https://discord.com/channels/@me/222",
          title: "Discord",
          mainText: "Direct messages",
          links: [
            { text: "Alice", href: "https://discord.com/channels/@me/111" },
            { text: "Bob", href: "https://discord.com/channels/@me/222" },
          ],
          forms: [],
        },
      ],
    });

    const status = await service.getDiscordConnectorStatus("owner");
    expect(status.available).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.reason).toBe("connected");
    expect(status.dmInbox).toMatchObject({
      visible: true,
      count: 2,
      selectedChannelId: "222",
    });
    expect(status.browserAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "lifeops_browser",
          active: true,
          authState: "logged_in",
          tabState: "dm_inbox_visible",
          nextAction: "none",
        }),
      ]),
    );
    expect(status.dmInbox.previews).toMatchObject([
      { label: "Alice", channelId: "111" },
      { label: "Bob", channelId: "222", selected: true },
    ]);
  });

  test("opens Discord through a browser session and uses the session probe once the Discord tab exists", async () => {
    const service = await createDiscordBrowserService(
      "lifeops-discord-browser-session",
    );

    await syncBrowserCompanionState(service, {
      tabs: [
        {
          windowId: "win-1",
          tabId: "news-tab",
          url: "https://example.com/",
          title: "Example",
          activeInWindow: true,
          focusedWindow: true,
          focusedActive: true,
        },
      ],
      pageContexts: [
        {
          windowId: "win-1",
          tabId: "news-tab",
          url: "https://example.com/",
          title: "Example",
          mainText: "Not Discord",
          links: [],
          forms: [],
        },
      ],
    });

    const pending = await service.authorizeDiscordConnector("owner");
    expect(pending.available).toBe(true);
    expect(pending.connected).toBe(false);
    expect(pending.reason).toBe("pairing");

    const [session] = await service.listBrowserSessions();
    expect(session).toBeDefined();
    expect(session.status).toBe("queued");
    expect(session.actions.map((action) => action.kind)).toEqual([
      "open",
      "read_page",
      "extract_links",
      "extract_forms",
    ]);

    const [openAction, readAction, linksAction, formsAction] = session.actions;
    await service.completeBrowserSession(session.id, {
      status: "done",
      result: {
        actionResults: {
          [openAction.id]: {
            openedUrl: "https://discord.com/channels/@me/222",
          },
          [readAction.id]: {
            url: "https://discord.com/channels/@me/222",
            title: "Discord",
            mainText: "Direct messages",
          },
          [linksAction.id]: {
            links: [
              { text: "Alice", href: "https://discord.com/channels/@me/111" },
              { text: "Bob", href: "https://discord.com/channels/@me/222" },
            ],
          },
          [formsAction.id]: {
            forms: [],
          },
        },
      },
    });

    await syncBrowserCompanionState(service, {
      tabs: [
        {
          windowId: "win-1",
          tabId: "news-tab",
          url: "https://example.com/",
          title: "Example",
          activeInWindow: true,
          focusedWindow: true,
          focusedActive: true,
        },
        {
          windowId: "win-1",
          tabId: "discord-tab",
          url: "https://discord.com/channels/@me/222",
          title: "Discord",
          activeInWindow: false,
          focusedWindow: true,
          focusedActive: false,
        },
      ],
      pageContexts: [
        {
          windowId: "win-1",
          tabId: "news-tab",
          url: "https://example.com/",
          title: "Example",
          mainText: "Still not Discord",
          links: [],
          forms: [],
        },
      ],
    });

    const status = await service.getDiscordConnectorStatus("owner");
    expect(status.connected).toBe(true);
    expect(status.reason).toBe("connected");
    expect(status.dmInbox).toMatchObject({
      visible: true,
      count: 2,
      selectedChannelId: "222",
    });
    expect(status.browserAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "lifeops_browser",
          active: true,
          nextAction: "none",
        }),
        expect.objectContaining({
          source: "desktop_browser",
          active: false,
        }),
      ]),
    );
    expect(status.grant?.metadata).toMatchObject({
      sessionId: session.id,
      companionId: expect.any(String),
    });
  });

  test("fails clearly when browser control is disabled and Discord is not already open", async () => {
    const service = await createDiscordBrowserService(
      "lifeops-discord-browser-disabled",
    );

    await syncBrowserCompanionState(service, {
      allowBrowserControl: false,
      tabs: [
        {
          windowId: "win-1",
          tabId: "docs-tab",
          url: "https://example.com/docs",
          title: "Docs",
          activeInWindow: true,
          focusedWindow: true,
          focusedActive: true,
        },
      ],
      pageContexts: [
        {
          windowId: "win-1",
          tabId: "docs-tab",
          url: "https://example.com/docs",
          title: "Docs",
          mainText: "No Discord here",
          links: [],
          forms: [],
        },
      ],
    });

    try {
      await service.authorizeDiscordConnector("owner");
      throw new Error("authorizeDiscordConnector should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(LifeOpsServiceError);
      expect((error as Error).message).toMatch(/browser control is disabled/i);
    }
  });
});

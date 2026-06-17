/**
 * Skills domain methods — skills, catalog, marketplace, apps, Feed,
 * custom actions, WhatsApp, agent events.
 */

import type {
  AppPermissionsView,
  CustomActionDef,
  PutAppPermissionsRequest,
} from "@elizaos/shared";
import { packageNameToAppRouteSlug } from "@elizaos/shared";
import { ElizaClient } from "./client-base";
import type {
  AppLaunchResult,
  AppRunActionResult,
  AppRunSummary,
  AppSessionActionResult,
  AppSessionControlAction,
  AppSessionState,
  AppStopResult,
  CatalogSearchResult,
  CatalogSkill,
  InstalledAppInfo,
  InstalledPlugin,
  PluginInstallResult,
  PluginMutationResult,
  RegistryAppInfo,
  RegistryPlugin,
  RegistryPluginItem,
  SkillInfo,
  SkillMarketplaceResult,
  SkillScanReportSummary,
} from "./client-types";
import type {
  FeedActivityFeed,
  FeedAgentGoal,
  FeedAgentStats,
  FeedAgentStatus,
  FeedChat,
  FeedChatMessage,
  FeedChatMessagesResponse,
  FeedChatResponse,
  FeedChatsResponse,
  FeedLogEntry,
  FeedPerpMarket,
  FeedPerpPosition,
  FeedPerpTradeResult,
  FeedPostResult,
  FeedPostsResponse,
  FeedPredictionMarket,
  FeedPredictionMarketsResponse,
  FeedSendMessageResult,
  FeedTeamChatInfo,
  FeedTeamResponse,
  FeedToggleResponse,
  FeedTradeResult,
  FeedWallet,
} from "./client-types-feed";

export type AppRunSteeringDisposition =
  | "accepted"
  | "queued"
  | "rejected"
  | "unsupported";

export interface AppRunSteeringResult {
  success: boolean;
  message: string;
  disposition: AppRunSteeringDisposition;
  status: number;
  run?: AppRunSummary | null;
  session?: AppSessionState | null;
}

/**
 * Wrapped response shape for `/api/setup/telegram-account/*` routes.
 *
 * Matches the canonical `SetupStatusResponse` in
 * `eliza/packages/app-core/src/api/setup-contract.ts` plus the connector-
 * specific detail block that drives the multi-step login wizard.
 */
export interface TelegramAccountSetupStatus {
  connector: "telegram-account";
  state: "idle" | "configuring" | "paired" | "error";
  detail: {
    status: string;
    configured: boolean;
    sessionExists: boolean;
    serviceConnected: boolean;
    restartRequired: boolean;
    hasAppCredentials: boolean;
    phone: string | null;
    isCodeViaApp: boolean;
    account: {
      id: string;
      username: string | null;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
    } | null;
    error: string | null;
  };
}

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

declare module "./client-base" {
  interface ElizaClient {
    getSkills(): Promise<{ skills: SkillInfo[] }>;
    refreshSkills(): Promise<{ ok: boolean; skills: SkillInfo[] }>;
    getSkillCatalog(opts?: {
      page?: number;
      perPage?: number;
      sort?: string;
    }): Promise<{
      total: number;
      page: number;
      perPage: number;
      totalPages: number;
      skills: CatalogSkill[];
    }>;
    searchSkillCatalog(
      query: string,
      limit?: number,
    ): Promise<{
      query: string;
      count: number;
      results: CatalogSearchResult[];
    }>;
    getSkillCatalogDetail(slug: string): Promise<{ skill: CatalogSkill }>;
    refreshSkillCatalog(): Promise<{ ok: boolean; count: number }>;
    installCatalogSkill(
      slug: string,
      version?: string,
    ): Promise<{
      ok: boolean;
      slug: string;
      message: string;
      alreadyInstalled?: boolean;
    }>;
    uninstallCatalogSkill(slug: string): Promise<{
      ok: boolean;
      slug: string;
      message: string;
    }>;
    getRegistryPlugins(): Promise<{
      count: number;
      plugins: RegistryPlugin[];
    }>;
    getRegistryPluginInfo(name: string): Promise<{ plugin: RegistryPlugin }>;
    getInstalledPlugins(): Promise<{
      count: number;
      plugins: InstalledPlugin[];
    }>;
    installRegistryPlugin(
      name: string,
      autoRestart?: boolean,
      options?: { stream?: "latest" | "beta"; version?: string },
    ): Promise<PluginInstallResult>;
    updateRegistryPlugin(
      name: string,
      autoRestart?: boolean,
      options?: { stream?: "latest" | "beta"; version?: string },
    ): Promise<PluginInstallResult>;
    uninstallRegistryPlugin(
      name: string,
      autoRestart?: boolean,
    ): Promise<PluginMutationResult & { pluginName: string }>;
    searchSkillsMarketplace(
      query: string,
      installed: boolean,
      limit: number,
    ): Promise<{ results: SkillMarketplaceResult[] }>;
    getSkillsMarketplaceConfig(): Promise<{ keySet: boolean }>;
    updateSkillsMarketplaceConfig(apiKey: string): Promise<{ keySet: boolean }>;
    installMarketplaceSkill(data: {
      slug?: string;
      githubUrl?: string;
      repository?: string;
      path?: string;
      name?: string;
      description?: string;
      source: string;
      autoRefresh?: boolean;
    }): Promise<void>;
    uninstallMarketplaceSkill(
      skillId: string,
      autoRefresh: boolean,
    ): Promise<void>;
    enableSkill(skillId: string): Promise<{
      ok: boolean;
      skill: SkillInfo;
      scanStatus: string | null;
    }>;
    disableSkill(skillId: string): Promise<{
      ok: boolean;
      skill: SkillInfo;
      scanStatus: string | null;
    }>;
    createSkill(
      name: string,
      description: string,
    ): Promise<{ ok: boolean; skill: SkillInfo; path: string }>;
    openSkill(id: string): Promise<{ ok: boolean; path: string }>;
    getSkillSource(id: string): Promise<{
      ok: boolean;
      skillId: string;
      content: string;
      path: string;
    }>;
    saveSkillSource(
      id: string,
      content: string,
    ): Promise<{ ok: boolean; skillId: string; skill: SkillInfo }>;
    deleteSkill(
      id: string,
    ): Promise<{ ok: boolean; skillId: string; source: string }>;
    getSkillScanReport(id: string): Promise<{
      ok: boolean;
      report: SkillScanReportSummary | null;
      acknowledged: boolean;
      acknowledgment: {
        acknowledgedAt: string;
        findingCount: number;
      } | null;
    }>;
    acknowledgeSkill(
      id: string,
      enable: boolean,
    ): Promise<{
      ok: boolean;
      skillId: string;
      acknowledged: boolean;
      enabled: boolean;
      findingCount: number;
    }>;
    listApps(): Promise<RegistryAppInfo[]>;
    listCatalogApps(): Promise<RegistryAppInfo[]>;
    searchApps(query: string): Promise<RegistryAppInfo[]>;
    listInstalledApps(): Promise<InstalledAppInfo[]>;
    listAppRuns(): Promise<AppRunSummary[]>;
    getAppRun(runId: string): Promise<AppRunSummary>;
    attachAppRun(runId: string): Promise<AppRunActionResult>;
    detachAppRun(runId: string): Promise<AppRunActionResult>;
    stopApp(name: string): Promise<AppStopResult>;
    stopAppRun(runId: string): Promise<AppStopResult>;
    /**
     * Cheap liveness ping for an app run. The server's stale-run sweeper
     * uses the heartbeat to decide whether to reap a run whose UI tab has
     * gone away. Returns the refreshed run summary on success, or throws
     * if the run no longer exists (e.g. the sweeper already reaped it,
     * or another window pressed Stop).
     */
    heartbeatAppRun(
      runId: string,
    ): Promise<{ ok: boolean; run: AppRunSummary }>;
    getAppInfo(name: string): Promise<RegistryAppInfo>;
    launchApp(name: string): Promise<AppLaunchResult>;
    /**
     * Returns one permissions view per registered app. Cheap enough to
     * call on Settings panel mount; the registry only stores
     * directory-loaded apps (typically <20 in practice).
     */
    listAppPermissions(): Promise<AppPermissionsView[]>;
    /**
     * Returns the merged declared + recognised + granted permission view
     * for an app. 404 if no app is registered under that slug.
     */
    getAppPermissions(slug: string): Promise<AppPermissionsView>;
    /**
     * Replaces the granted-namespace set for an app. Idempotent. Server
     * rejects unknown namespace names and namespaces the app's manifest
     * did not declare.
     */
    setAppPermissions(
      slug: string,
      namespaces: readonly string[],
    ): Promise<AppPermissionsView>;
    sendAppRunMessage(
      runId: string,
      content: string,
    ): Promise<AppRunSteeringResult>;
    controlAppRun(
      runId: string,
      action: AppSessionControlAction,
    ): Promise<AppRunSteeringResult>;
    getAppSessionState(
      appName: string,
      sessionId: string,
    ): Promise<AppSessionState>;
    sendAppSessionMessage(
      appName: string,
      sessionId: string,
      content: string,
    ): Promise<AppSessionActionResult>;
    controlAppSession(
      appName: string,
      sessionId: string,
      action: AppSessionControlAction,
    ): Promise<AppSessionActionResult>;
    listRegistryPlugins(): Promise<RegistryPluginItem[]>;
    searchRegistryPlugins(query: string): Promise<RegistryPluginItem[]>;
    listCustomActions(): Promise<CustomActionDef[]>;
    createCustomAction(
      action: Omit<CustomActionDef, "id" | "createdAt" | "updatedAt">,
    ): Promise<CustomActionDef>;
    updateCustomAction(
      id: string,
      action: Partial<CustomActionDef>,
    ): Promise<CustomActionDef>;
    deleteCustomAction(id: string): Promise<void>;
    testCustomAction(
      id: string,
      params: Record<string, string>,
    ): Promise<{
      ok: boolean;
      output: string;
      error?: string;
      durationMs: number;
    }>;
    generateCustomAction(
      prompt: string,
    ): Promise<{ ok: boolean; generated: Record<string, unknown> }>;
    getWhatsAppStatus(
      accountId?: string,
      options?: { authScope?: "platform" | "lifeops" },
    ): Promise<{
      accountId: string;
      authScope?: "platform" | "lifeops";
      status: string;
      authExists: boolean;
      serviceConnected: boolean;
      servicePhone: string | null;
    }>;
    startWhatsAppPairing(
      accountId?: string,
      options?: {
        configurePlugin?: boolean;
        authScope?: "platform" | "lifeops";
      },
    ): Promise<{
      ok: boolean;
      accountId: string;
      authScope?: "platform" | "lifeops";
      status: string;
      error?: string;
    }>;
    stopWhatsAppPairing(
      accountId?: string,
      options?: { authScope?: "platform" | "lifeops" },
    ): Promise<{
      ok: boolean;
      accountId: string;
      authScope?: "platform" | "lifeops";
      status: string;
    }>;
    disconnectWhatsApp(
      accountId?: string,
      options?: {
        configurePlugin?: boolean;
        authScope?: "platform" | "lifeops";
      },
    ): Promise<{
      ok: boolean;
      accountId: string;
      authScope?: "platform" | "lifeops";
    }>;
    getSignalStatus(accountId?: string): Promise<{
      accountId: string;
      status: string;
      authExists: boolean;
      serviceConnected: boolean;
      qrDataUrl: string | null;
      phoneNumber: string | null;
      error: string | null;
    }>;
    startSignalPairing(accountId?: string): Promise<{
      ok: boolean;
      accountId: string;
      status: string;
      error?: string;
    }>;
    stopSignalPairing(accountId?: string): Promise<{
      ok: boolean;
      accountId: string;
      status: string;
    }>;
    disconnectSignal(accountId?: string): Promise<{
      ok: boolean;
      accountId: string;
    }>;
    getTelegramAccountStatus(): Promise<TelegramAccountSetupStatus>;
    startTelegramAccountAuth(
      phone?: string,
    ): Promise<TelegramAccountSetupStatus>;
    submitTelegramAccountAuth(input: {
      provisioningCode?: string;
      telegramCode?: string;
      password?: string;
    }): Promise<TelegramAccountSetupStatus>;
    disconnectTelegramAccount(): Promise<TelegramAccountSetupStatus>;
    getDiscordLocalStatus(): Promise<{
      available: boolean;
      connected: boolean;
      authenticated: boolean;
      currentUser?: {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
      } | null;
      subscribedChannelIds: string[];
      configuredChannelIds: string[];
      scopes: string[];
      lastError: string | null;
      ipcPath: string | null;
    }>;
    authorizeDiscordLocal(): Promise<{
      available: boolean;
      connected: boolean;
      authenticated: boolean;
      currentUser?: {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
      } | null;
      subscribedChannelIds: string[];
      configuredChannelIds: string[];
      scopes: string[];
      lastError: string | null;
      ipcPath: string | null;
    }>;
    disconnectDiscordLocal(): Promise<{ ok: boolean }>;
    listDiscordLocalGuilds(): Promise<{
      guilds: Array<{ id: string; name: string }>;
      count: number;
    }>;
    listDiscordLocalChannels(guildId: string): Promise<{
      channels: Array<{
        id: string;
        guild_id?: string | null;
        type?: number;
        name?: string | null;
        recipients?: Array<{
          id: string;
          username: string;
          global_name?: string | null;
          avatar?: string | null;
        }>;
      }>;
      count: number;
    }>;
    saveDiscordLocalSubscriptions(channelIds: string[]): Promise<{
      subscribedChannelIds: string[];
    }>;
    getBlueBubblesStatus(): Promise<{
      available: boolean;
      connected: boolean;
      webhookPath: string;
      reason?: string;
    }>;

    // Feed terminal methods
    getFeedAgentStatus(): Promise<FeedAgentStatus>;
    getFeedAgentActivity(opts?: {
      limit?: number;
      type?: string;
    }): Promise<FeedActivityFeed>;
    getFeedAgentLogs(opts?: {
      type?: string;
      level?: string;
    }): Promise<FeedLogEntry[]>;
    getFeedAgentWallet(): Promise<FeedWallet>;
    getFeedTeam(): Promise<FeedTeamResponse>;
    getFeedTeamChat(): Promise<FeedTeamChatInfo>;
    sendFeedTeamChat(
      content: string,
      mentions?: string[],
    ): Promise<FeedChatResponse>;
    toggleFeedAgent(
      action: "pause" | "resume" | "toggle",
    ): Promise<FeedToggleResponse>;
    toggleFeedAgentAutonomy(opts: {
      trading?: boolean;
      posting?: boolean;
      commenting?: boolean;
      dms?: boolean;
    }): Promise<FeedToggleResponse>;

    // Feed markets
    getFeedPredictionMarkets(opts?: {
      page?: number;
      pageSize?: number;
      status?: string;
      category?: string;
    }): Promise<FeedPredictionMarketsResponse>;
    getFeedPredictionMarket(marketId: string): Promise<FeedPredictionMarket>;
    buyFeedPredictionShares(
      marketId: string,
      side: "yes" | "no",
      amount: number,
    ): Promise<FeedTradeResult>;
    sellFeedPredictionShares(
      marketId: string,
      side: "yes" | "no",
      amount: number,
    ): Promise<FeedTradeResult>;
    getFeedPerpMarkets(): Promise<FeedPerpMarket[]>;
    getFeedOpenPerpPositions(): Promise<FeedPerpPosition[]>;
    closeFeedPerpPosition(positionId: string): Promise<FeedPerpTradeResult>;

    // Feed social
    getFeedPosts(opts?: {
      page?: number;
      limit?: number;
      feed?: string;
    }): Promise<FeedPostsResponse>;
    createFeedPost(content: string, marketId?: string): Promise<FeedPostResult>;
    commentOnFeedPost(postId: string, content: string): Promise<FeedPostResult>;
    likeFeedPost(postId: string): Promise<{ ok: boolean }>;

    // Feed messaging
    getFeedChats(): Promise<FeedChatsResponse>;
    getFeedChatMessages(chatId: string): Promise<FeedChatMessagesResponse>;
    sendFeedChatMessage(
      chatId: string,
      content: string,
    ): Promise<FeedSendMessageResult>;
    getFeedDM(userId: string): Promise<FeedChat>;

    // Feed agent management
    getFeedAgentGoals(): Promise<FeedAgentGoal[]>;
    getFeedAgentStats(): Promise<FeedAgentStats>;
    /**
     * Raw proxied Feed `/agent/summary` response. The client does no parsing
     * (it just forwards the upstream body), so the type is `unknown` and the
     * caller validates it — `plugin-feed`'s `extractAgentSummary(value: unknown)`
     * is the authoritative parser, producing a `FeedAgentSummaryEnvelope`
     * (`{agent,portfolio,positions}`). The former `Promise<FeedAgentSummary>`
     * annotation was a false claim: the method never constructs that shape.
     */
    getFeedAgentSummary(): Promise<unknown>;
    getFeedAgentRecentTrades(): Promise<FeedActivityFeed>;
    getFeedAgentTradingBalance(): Promise<{ balance: number }>;
    sendFeedAgentChat(content: string): Promise<FeedChatResponse>;
    getFeedAgentChat(): Promise<{ messages: FeedChatMessage[] }>;

    // Feed feed
    getFeedFeedForYou(): Promise<FeedPostsResponse>;
    getFeedFeedHot(): Promise<FeedPostsResponse>;
    getFeedTrades(): Promise<FeedActivityFeed>;

    // Feed discover & team
    discoverFeedAgents(): Promise<FeedTeamResponse>;
    getFeedTeamDashboard(): Promise<Record<string, unknown>>;
    getFeedTeamConversations(): Promise<Record<string, unknown>>;
    pauseAllFeedAgents(): Promise<{ ok: boolean }>;
    resumeAllFeedAgents(): Promise<{ ok: boolean }>;
  }
}

// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------

ElizaClient.prototype.getSkills = async function (this: ElizaClient) {
  return this.fetch("/api/skills");
};

ElizaClient.prototype.refreshSkills = async function (this: ElizaClient) {
  return this.fetch("/api/skills/refresh", { method: "POST" });
};

ElizaClient.prototype.getSkillCatalog = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.perPage) params.set("perPage", String(opts.perPage));
  if (opts?.sort) params.set("sort", opts.sort);
  const qs = params.toString();
  return this.fetch(`/api/skills/catalog${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.searchSkillCatalog = async function (
  this: ElizaClient,
  query,
  limit = 30,
) {
  return this.fetch(
    `/api/skills/catalog/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
};

ElizaClient.prototype.getSkillCatalogDetail = async function (
  this: ElizaClient,
  slug,
) {
  return this.fetch(`/api/skills/catalog/${encodeURIComponent(slug)}`);
};

ElizaClient.prototype.refreshSkillCatalog = async function (this: ElizaClient) {
  return this.fetch("/api/skills/catalog/refresh", { method: "POST" });
};

ElizaClient.prototype.installCatalogSkill = async function (
  this: ElizaClient,
  slug,
  version?,
) {
  return this.fetch("/api/skills/catalog/install", {
    method: "POST",
    body: JSON.stringify({ slug, version }),
  });
};

ElizaClient.prototype.uninstallCatalogSkill = async function (
  this: ElizaClient,
  slug,
) {
  return this.fetch("/api/skills/catalog/uninstall", {
    method: "POST",
    body: JSON.stringify({ slug }),
  });
};

ElizaClient.prototype.getRegistryPlugins = async function (this: ElizaClient) {
  return this.fetch("/api/registry/plugins");
};

ElizaClient.prototype.getRegistryPluginInfo = async function (
  this: ElizaClient,
  name,
) {
  return this.fetch(`/api/registry/plugins/${encodeURIComponent(name)}`);
};

ElizaClient.prototype.getInstalledPlugins = async function (this: ElizaClient) {
  return this.fetch("/api/plugins/installed");
};

ElizaClient.prototype.installRegistryPlugin = async function (
  this: ElizaClient,
  name,
  autoRestart = true,
  options = {},
) {
  return this.fetch(
    "/api/plugins/install",
    {
      method: "POST",
      body: JSON.stringify({ name, autoRestart, ...options }),
    },
    { timeoutMs: 120_000 },
  );
};

ElizaClient.prototype.updateRegistryPlugin = async function (
  this: ElizaClient,
  name,
  autoRestart = true,
  options = {},
) {
  return this.fetch(
    "/api/plugins/update",
    {
      method: "POST",
      body: JSON.stringify({ name, autoRestart, ...options }),
    },
    { timeoutMs: 120_000 },
  );
};

ElizaClient.prototype.uninstallRegistryPlugin = async function (
  this: ElizaClient,
  name,
  autoRestart = true,
) {
  return this.fetch("/api/plugins/uninstall", {
    method: "POST",
    body: JSON.stringify({ name, autoRestart }),
  });
};

ElizaClient.prototype.searchSkillsMarketplace = async function (
  this: ElizaClient,
  query,
  installed,
  limit,
) {
  const params = new URLSearchParams({
    q: query,
    installed: String(installed),
    limit: String(limit),
  });
  return this.fetch(`/api/skills/marketplace/search?${params}`);
};

ElizaClient.prototype.getSkillsMarketplaceConfig = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/skills/marketplace/config");
};

ElizaClient.prototype.updateSkillsMarketplaceConfig = async function (
  this: ElizaClient,
  apiKey,
) {
  return this.fetch("/api/skills/marketplace/config", {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
};

ElizaClient.prototype.installMarketplaceSkill = async function (
  this: ElizaClient,
  data,
) {
  await this.fetch("/api/skills/marketplace/install", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.uninstallMarketplaceSkill = async function (
  this: ElizaClient,
  skillId,
  autoRefresh,
) {
  await this.fetch("/api/skills/marketplace/uninstall", {
    method: "POST",
    body: JSON.stringify({ id: skillId, autoRefresh }),
  });
};

ElizaClient.prototype.enableSkill = async function (
  this: ElizaClient,
  skillId,
) {
  return this.fetch(`/api/skills/${encodeURIComponent(skillId)}/enable`, {
    method: "POST",
  });
};

ElizaClient.prototype.disableSkill = async function (
  this: ElizaClient,
  skillId,
) {
  return this.fetch(`/api/skills/${encodeURIComponent(skillId)}/disable`, {
    method: "POST",
  });
};

ElizaClient.prototype.createSkill = async function (
  this: ElizaClient,
  name,
  description,
) {
  return this.fetch("/api/skills/create", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
};

ElizaClient.prototype.openSkill = async function (this: ElizaClient, id) {
  return this.fetch(`/api/skills/${encodeURIComponent(id)}/open`, {
    method: "POST",
  });
};

ElizaClient.prototype.getSkillSource = async function (this: ElizaClient, id) {
  return this.fetch(`/api/skills/${encodeURIComponent(id)}/source`);
};

ElizaClient.prototype.saveSkillSource = async function (
  this: ElizaClient,
  id,
  content,
) {
  return this.fetch(`/api/skills/${encodeURIComponent(id)}/source`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
};

ElizaClient.prototype.deleteSkill = async function (this: ElizaClient, id) {
  return this.fetch(`/api/skills/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.getSkillScanReport = async function (
  this: ElizaClient,
  id,
) {
  return this.fetch(`/api/skills/${encodeURIComponent(id)}/scan`);
};

ElizaClient.prototype.acknowledgeSkill = async function (
  this: ElizaClient,
  id,
  enable,
) {
  return this.fetch(`/api/skills/${encodeURIComponent(id)}/acknowledge`, {
    method: "POST",
    body: JSON.stringify({ enable }),
  });
};

ElizaClient.prototype.listApps = async function (this: ElizaClient) {
  return this.fetch("/api/apps");
};

ElizaClient.prototype.listCatalogApps = async function (this: ElizaClient) {
  return this.fetch("/api/catalog/apps");
};

ElizaClient.prototype.searchApps = async function (this: ElizaClient, query) {
  return this.fetch(`/api/apps/search?q=${encodeURIComponent(query)}`);
};

ElizaClient.prototype.listInstalledApps = async function (this: ElizaClient) {
  return this.fetch("/api/apps/installed");
};

ElizaClient.prototype.listAppRuns = async function (this: ElizaClient) {
  return this.fetch("/api/apps/runs");
};

ElizaClient.prototype.getAppRun = async function (this: ElizaClient, runId) {
  return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}`);
};

ElizaClient.prototype.attachAppRun = async function (this: ElizaClient, runId) {
  return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/attach`, {
    method: "POST",
  });
};

ElizaClient.prototype.detachAppRun = async function (this: ElizaClient, runId) {
  return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/detach`, {
    method: "POST",
  });
};

ElizaClient.prototype.stopApp = async function (this: ElizaClient, name) {
  return this.fetch("/api/apps/stop", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
};

ElizaClient.prototype.stopAppRun = async function (this: ElizaClient, runId) {
  return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
  });
};

ElizaClient.prototype.heartbeatAppRun = async function (
  this: ElizaClient,
  runId,
) {
  return this.fetch(`/api/apps/runs/${encodeURIComponent(runId)}/heartbeat`, {
    method: "POST",
  });
};

ElizaClient.prototype.getAppInfo = async function (this: ElizaClient, name) {
  return this.fetch(`/api/apps/info/${encodeURIComponent(name)}`);
};

ElizaClient.prototype.launchApp = async function (this: ElizaClient, name) {
  return this.fetch("/api/apps/launch", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
};

ElizaClient.prototype.listAppPermissions = async function (this: ElizaClient) {
  return this.fetch("/api/apps/permissions");
};

ElizaClient.prototype.getAppPermissions = async function (
  this: ElizaClient,
  slug,
) {
  return this.fetch(`/api/apps/permissions/${encodeURIComponent(slug)}`);
};

ElizaClient.prototype.setAppPermissions = async function (
  this: ElizaClient,
  slug,
  namespaces,
) {
  // Body shape derived from the zod schema so a server-side rename
  // surfaces as a TS error here at compile time. See
  // packages/shared/src/contracts/app-permissions-routes.ts for the
  // schema this type comes from.
  const body: PutAppPermissionsRequest = {
    namespaces: Array.from(namespaces),
  };
  return this.fetch(`/api/apps/permissions/${encodeURIComponent(slug)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
};

ElizaClient.prototype.sendAppRunMessage = async function (
  this: ElizaClient,
  runId,
  content,
) {
  const response = await this.rawRequest(
    `/api/apps/runs/${encodeURIComponent(runId)}/message`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
    },
    { allowNonOk: true },
  );
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return {
    success: Boolean(data.success),
    message:
      typeof data.message === "string" && data.message.trim().length > 0
        ? data.message.trim()
        : response.status === 202
          ? "Command queued."
          : response.status >= 500
            ? "Command unavailable."
            : "Command rejected.",
    disposition:
      data.disposition === "accepted" ||
      data.disposition === "queued" ||
      data.disposition === "rejected" ||
      data.disposition === "unsupported"
        ? data.disposition
        : response.status === 202
          ? "queued"
          : response.status >= 500
            ? "unsupported"
            : response.status >= 400
              ? "rejected"
              : "accepted",
    status: response.status,
    run:
      data.run && typeof data.run === "object"
        ? (data.run as AppRunSummary)
        : null,
    session:
      data.session && typeof data.session === "object"
        ? (data.session as AppSessionState)
        : null,
  };
};

ElizaClient.prototype.controlAppRun = async function (
  this: ElizaClient,
  runId,
  action,
) {
  const response = await this.rawRequest(
    `/api/apps/runs/${encodeURIComponent(runId)}/control`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
    },
    { allowNonOk: true },
  );
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return {
    success: Boolean(data.success),
    message:
      typeof data.message === "string" && data.message.trim().length > 0
        ? data.message.trim()
        : response.status === 202
          ? "Command queued."
          : response.status >= 500
            ? "Command unavailable."
            : "Command rejected.",
    disposition:
      data.disposition === "accepted" ||
      data.disposition === "queued" ||
      data.disposition === "rejected" ||
      data.disposition === "unsupported"
        ? data.disposition
        : response.status === 202
          ? "queued"
          : response.status >= 500
            ? "unsupported"
            : response.status >= 400
              ? "rejected"
              : "accepted",
    status: response.status,
    run:
      data.run && typeof data.run === "object"
        ? (data.run as AppRunSummary)
        : null,
    session:
      data.session && typeof data.session === "object"
        ? (data.session as AppSessionState)
        : null,
  };
};

ElizaClient.prototype.getAppSessionState = async function (
  this: ElizaClient,
  appName,
  sessionId,
) {
  const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
  return this.fetch(
    `/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}`,
  );
};

ElizaClient.prototype.sendAppSessionMessage = async function (
  this: ElizaClient,
  appName,
  sessionId,
  content,
) {
  const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
  return this.fetch(
    `/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
    },
  );
};

ElizaClient.prototype.controlAppSession = async function (
  this: ElizaClient,
  appName,
  sessionId,
  action,
) {
  const routeSlug = packageNameToAppRouteSlug(appName) ?? appName;
  return this.fetch(
    `/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(sessionId)}/control`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
    },
  );
};

ElizaClient.prototype.listRegistryPlugins = async function (this: ElizaClient) {
  return this.fetch("/api/apps/plugins");
};

ElizaClient.prototype.searchRegistryPlugins = async function (
  this: ElizaClient,
  query,
) {
  return this.fetch(`/api/apps/plugins/search?q=${encodeURIComponent(query)}`);
};

ElizaClient.prototype.listCustomActions = async function (this: ElizaClient) {
  const data = await this.fetch<{ actions: CustomActionDef[] }>(
    "/api/custom-actions",
  );
  return data.actions;
};

ElizaClient.prototype.createCustomAction = async function (
  this: ElizaClient,
  action,
) {
  const data = await this.fetch<{ ok: boolean; action: CustomActionDef }>(
    "/api/custom-actions",
    { method: "POST", body: JSON.stringify(action) },
  );
  return data.action;
};

ElizaClient.prototype.updateCustomAction = async function (
  this: ElizaClient,
  id,
  action,
) {
  const data = await this.fetch<{ ok: boolean; action: CustomActionDef }>(
    `/api/custom-actions/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(action) },
  );
  return data.action;
};

ElizaClient.prototype.deleteCustomAction = async function (
  this: ElizaClient,
  id,
) {
  await this.fetch(`/api/custom-actions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.testCustomAction = async function (
  this: ElizaClient,
  id,
  params,
) {
  return this.fetch(`/api/custom-actions/${encodeURIComponent(id)}/test`, {
    method: "POST",
    body: JSON.stringify({ params }),
  });
};

ElizaClient.prototype.generateCustomAction = async function (
  this: ElizaClient,
  prompt,
) {
  return this.fetch("/api/custom-actions/generate", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
};

ElizaClient.prototype.getWhatsAppStatus = async function (
  this: ElizaClient,
  accountId = "default",
  options = {},
) {
  const params = new URLSearchParams({ accountId });
  if (options.authScope) {
    params.set("authScope", options.authScope);
  }
  return this.fetch(`/api/whatsapp/status?${params.toString()}`);
};

ElizaClient.prototype.startWhatsAppPairing = async function (
  this: ElizaClient,
  accountId = "default",
  options = {},
) {
  return this.fetch("/api/whatsapp/pair", {
    method: "POST",
    body: JSON.stringify({ ...options, accountId }),
  });
};

ElizaClient.prototype.stopWhatsAppPairing = async function (
  this: ElizaClient,
  accountId = "default",
  options = {},
) {
  return this.fetch("/api/whatsapp/pair/stop", {
    method: "POST",
    body: JSON.stringify({ ...options, accountId }),
  });
};

ElizaClient.prototype.disconnectWhatsApp = async function (
  this: ElizaClient,
  accountId = "default",
  options = {},
) {
  return this.fetch("/api/whatsapp/disconnect", {
    method: "POST",
    body: JSON.stringify({ ...options, accountId }),
  });
};

ElizaClient.prototype.getSignalStatus = async function (
  this: ElizaClient,
  accountId = "default",
) {
  return this.fetch(
    `/api/signal/status?accountId=${encodeURIComponent(accountId)}`,
  );
};

ElizaClient.prototype.startSignalPairing = async function (
  this: ElizaClient,
  accountId = "default",
): Promise<{
  ok: boolean;
  accountId: string;
  status: string;
  error?: string;
}> {
  return this.fetch<{
    ok: boolean;
    accountId: string;
    status: string;
    error?: string;
  }>("/api/signal/pair", {
    method: "POST",
    body: JSON.stringify({ accountId }),
  });
};

ElizaClient.prototype.stopSignalPairing = async function (
  this: ElizaClient,
  accountId = "default",
): Promise<{
  ok: boolean;
  accountId: string;
  status: string;
}> {
  return this.fetch<{
    ok: boolean;
    accountId: string;
    status: string;
  }>("/api/signal/pair/stop", {
    method: "POST",
    body: JSON.stringify({ accountId }),
  });
};

ElizaClient.prototype.disconnectSignal = async function (
  this: ElizaClient,
  accountId = "default",
) {
  return this.fetch("/api/signal/disconnect", {
    method: "POST",
    body: JSON.stringify({ accountId }),
  });
};

ElizaClient.prototype.getTelegramAccountStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/setup/telegram-account/status");
};

ElizaClient.prototype.startTelegramAccountAuth = async function (
  this: ElizaClient,
  phone,
) {
  return this.fetch("/api/setup/telegram-account/start", {
    method: "POST",
    body: JSON.stringify(
      typeof phone === "string" && phone.trim().length > 0
        ? { phone: phone.trim() }
        : {},
    ),
  });
};

ElizaClient.prototype.submitTelegramAccountAuth = async function (
  this: ElizaClient,
  input,
) {
  return this.fetch("/api/setup/telegram-account/submit-code", {
    method: "POST",
    body: JSON.stringify(input),
  });
};

ElizaClient.prototype.disconnectTelegramAccount = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/setup/telegram-account/cancel", {
    method: "POST",
  });
};

ElizaClient.prototype.getDiscordLocalStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/discord-local/status");
};

ElizaClient.prototype.authorizeDiscordLocal = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/discord-local/authorize", {
    method: "POST",
  });
};

ElizaClient.prototype.disconnectDiscordLocal = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/discord-local/disconnect", {
    method: "POST",
  });
};

ElizaClient.prototype.listDiscordLocalGuilds = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/discord-local/guilds");
};

ElizaClient.prototype.listDiscordLocalChannels = async function (
  this: ElizaClient,
  guildId,
) {
  return this.fetch(
    `/api/discord-local/channels?guildId=${encodeURIComponent(guildId)}`,
  );
};

ElizaClient.prototype.saveDiscordLocalSubscriptions = async function (
  this: ElizaClient,
  channelIds,
) {
  return this.fetch("/api/discord-local/subscriptions", {
    method: "POST",
    body: JSON.stringify({ channelIds }),
  });
};

ElizaClient.prototype.getBlueBubblesStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/bluebubbles/status");
};

// ---------------------------------------------------------------------------
// Feed terminal methods
// ---------------------------------------------------------------------------

ElizaClient.prototype.getFeedAgentStatus = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/agent/status");
};

ElizaClient.prototype.getFeedAgentActivity = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.type) params.set("type", opts.type);
  const qs = params.toString();
  return this.fetch(`/api/apps/feed/agent/activity${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.getFeedAgentLogs = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.type) params.set("type", opts.type);
  if (opts?.level) params.set("level", opts.level);
  const qs = params.toString();
  return this.fetch(`/api/apps/feed/agent/logs${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.getFeedAgentWallet = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/agent/wallet");
};

ElizaClient.prototype.getFeedTeam = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/team");
};

ElizaClient.prototype.getFeedTeamChat = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/team/info");
};

ElizaClient.prototype.sendFeedTeamChat = async function (
  this: ElizaClient,
  content,
  mentions?,
) {
  return this.fetch("/api/apps/feed/team/chat", {
    method: "POST",
    body: JSON.stringify({ content, mentions }),
  });
};

ElizaClient.prototype.toggleFeedAgent = async function (
  this: ElizaClient,
  action,
) {
  return this.fetch("/api/apps/feed/agent/toggle", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
};

ElizaClient.prototype.toggleFeedAgentAutonomy = async function (
  this: ElizaClient,
  opts,
) {
  return this.fetch("/api/apps/feed", {
    method: "POST",
    body: JSON.stringify(opts),
  });
};

// ---------------------------------------------------------------------------
// Feed markets
// ---------------------------------------------------------------------------

ElizaClient.prototype.getFeedPredictionMarkets = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
  if (opts?.status) params.set("status", opts.status);
  if (opts?.category) params.set("category", opts.category);
  const qs = params.toString();
  return this.fetch(`/api/apps/feed/markets/predictions${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.getFeedPredictionMarket = async function (
  this: ElizaClient,
  marketId,
) {
  return this.fetch(
    `/api/apps/feed/markets/predictions/${encodeURIComponent(marketId)}`,
  );
};

ElizaClient.prototype.buyFeedPredictionShares = async function (
  this: ElizaClient,
  marketId,
  side,
  amount,
) {
  return this.fetch(
    `/api/apps/feed/markets/predictions/${encodeURIComponent(marketId)}/buy`,
    { method: "POST", body: JSON.stringify({ side, amount }) },
  );
};

ElizaClient.prototype.sellFeedPredictionShares = async function (
  this: ElizaClient,
  marketId,
  side,
  amount,
) {
  return this.fetch(
    `/api/apps/feed/markets/predictions/${encodeURIComponent(marketId)}/sell`,
    { method: "POST", body: JSON.stringify({ side, amount }) },
  );
};

ElizaClient.prototype.getFeedPerpMarkets = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/markets/perps");
};

ElizaClient.prototype.getFeedOpenPerpPositions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/feed/markets/perps/open");
};

ElizaClient.prototype.closeFeedPerpPosition = async function (
  this: ElizaClient,
  positionId,
) {
  return this.fetch(
    `/api/apps/feed/markets/perps/position/${encodeURIComponent(positionId)}/close`,
    { method: "POST", body: JSON.stringify({}) },
  );
};

// ---------------------------------------------------------------------------
// Feed social
// ---------------------------------------------------------------------------

ElizaClient.prototype.getFeedPosts = async function (this: ElizaClient, opts?) {
  const params = new URLSearchParams();
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.feed) params.set("feed", opts.feed);
  const qs = params.toString();
  return this.fetch(`/api/apps/feed/posts${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.createFeedPost = async function (
  this: ElizaClient,
  content,
  marketId?,
) {
  return this.fetch("/api/apps/feed/posts", {
    method: "POST",
    body: JSON.stringify({ content, marketId }),
  });
};

ElizaClient.prototype.commentOnFeedPost = async function (
  this: ElizaClient,
  postId,
  content,
) {
  return this.fetch(
    `/api/apps/feed/posts/${encodeURIComponent(postId)}/comments`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
};

ElizaClient.prototype.likeFeedPost = async function (
  this: ElizaClient,
  postId,
) {
  return this.fetch(`/api/apps/feed/posts/${encodeURIComponent(postId)}/like`, {
    method: "POST",
  });
};

// ---------------------------------------------------------------------------
// Feed messaging
// ---------------------------------------------------------------------------

ElizaClient.prototype.getFeedChats = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/chats");
};

ElizaClient.prototype.getFeedChatMessages = async function (
  this: ElizaClient,
  chatId,
) {
  return this.fetch(
    `/api/apps/feed/chats/${encodeURIComponent(chatId)}/messages`,
  );
};

ElizaClient.prototype.sendFeedChatMessage = async function (
  this: ElizaClient,
  chatId,
  content,
) {
  return this.fetch(
    `/api/apps/feed/chats/${encodeURIComponent(chatId)}/message`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
};

ElizaClient.prototype.getFeedDM = async function (this: ElizaClient, userId) {
  return this.fetch(
    `/api/apps/feed/chats/dm?userId=${encodeURIComponent(userId)}`,
  );
};

// ---------------------------------------------------------------------------
// Feed agent management
// ---------------------------------------------------------------------------

ElizaClient.prototype.getFeedAgentGoals = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/agent/goals");
};

ElizaClient.prototype.getFeedAgentStats = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/agent/stats");
};

ElizaClient.prototype.getFeedAgentSummary = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/agent/summary");
};

ElizaClient.prototype.getFeedAgentRecentTrades = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/feed/agent/recent-trades");
};

ElizaClient.prototype.getFeedAgentTradingBalance = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/feed/agent/trading-balance");
};

ElizaClient.prototype.sendFeedAgentChat = async function (
  this: ElizaClient,
  content,
) {
  return this.fetch("/api/apps/feed/agent/chat", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
};

ElizaClient.prototype.getFeedAgentChat = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/agent/chat");
};

// ---------------------------------------------------------------------------
// Feed feed
// ---------------------------------------------------------------------------

ElizaClient.prototype.getFeedFeedForYou = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/feed/for-you");
};

ElizaClient.prototype.getFeedFeedHot = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/feed/hot");
};

ElizaClient.prototype.getFeedTrades = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/trades");
};

// ---------------------------------------------------------------------------
// Feed discover & team management
// ---------------------------------------------------------------------------

ElizaClient.prototype.discoverFeedAgents = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/agents/discover");
};

ElizaClient.prototype.getFeedTeamDashboard = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/feed/team/dashboard");
};

ElizaClient.prototype.getFeedTeamConversations = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/feed/team/conversations");
};

ElizaClient.prototype.pauseAllFeedAgents = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/admin/agents/pause-all", {
    method: "POST",
  });
};

ElizaClient.prototype.resumeAllFeedAgents = async function (this: ElizaClient) {
  return this.fetch("/api/apps/feed/admin/agents/resume-all", {
    method: "POST",
  });
};

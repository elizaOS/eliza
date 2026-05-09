/**
 * Skills domain methods — skills, catalog, marketplace, apps, Babylon,
 * custom actions, WhatsApp, agent events.
 */

import type { CustomActionDef } from "@elizaos/agent";
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
  BabylonActivityFeed,
  BabylonAgentGoal,
  BabylonAgentStats,
  BabylonAgentStatus,
  BabylonAgentSummary,
  BabylonChat,
  BabylonChatMessage,
  BabylonChatMessagesResponse,
  BabylonChatResponse,
  BabylonChatsResponse,
  BabylonLogEntry,
  BabylonPerpMarket,
  BabylonPerpPosition,
  BabylonPerpTradeResult,
  BabylonPostResult,
  BabylonPostsResponse,
  BabylonPredictionMarket,
  BabylonPredictionMarketsResponse,
  BabylonSendMessageResult,
  BabylonTeamChatInfo,
  BabylonTeamResponse,
  BabylonToggleResponse,
  BabylonTradeResult,
  BabylonWallet,
} from "./client-types-babylon";

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
    getTelegramAccountStatus(): Promise<{
      available: boolean;
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
    }>;
    startTelegramAccountAuth(phone?: string): Promise<{
      available: boolean;
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
    }>;
    submitTelegramAccountAuth(input: {
      provisioningCode?: string;
      telegramCode?: string;
      password?: string;
    }): Promise<{
      available: boolean;
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
    }>;
    disconnectTelegramAccount(): Promise<{
      ok: boolean;
      available: boolean;
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
    }>;
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

    // Babylon terminal methods
    getBabylonAgentStatus(): Promise<BabylonAgentStatus>;
    getBabylonAgentActivity(opts?: {
      limit?: number;
      type?: string;
    }): Promise<BabylonActivityFeed>;
    getBabylonAgentLogs(opts?: {
      type?: string;
      level?: string;
    }): Promise<BabylonLogEntry[]>;
    getBabylonAgentWallet(): Promise<BabylonWallet>;
    getBabylonTeam(): Promise<BabylonTeamResponse>;
    getBabylonTeamChat(): Promise<BabylonTeamChatInfo>;
    sendBabylonTeamChat(
      content: string,
      mentions?: string[],
    ): Promise<BabylonChatResponse>;
    toggleBabylonAgent(
      action: "pause" | "resume" | "toggle",
    ): Promise<BabylonToggleResponse>;
    toggleBabylonAgentAutonomy(opts: {
      trading?: boolean;
      posting?: boolean;
      commenting?: boolean;
      dms?: boolean;
    }): Promise<BabylonToggleResponse>;

    // Babylon markets
    getBabylonPredictionMarkets(opts?: {
      page?: number;
      pageSize?: number;
      status?: string;
      category?: string;
    }): Promise<BabylonPredictionMarketsResponse>;
    getBabylonPredictionMarket(
      marketId: string,
    ): Promise<BabylonPredictionMarket>;
    buyBabylonPredictionShares(
      marketId: string,
      side: "yes" | "no",
      amount: number,
    ): Promise<BabylonTradeResult>;
    sellBabylonPredictionShares(
      marketId: string,
      side: "yes" | "no",
      amount: number,
    ): Promise<BabylonTradeResult>;
    getBabylonPerpMarkets(): Promise<BabylonPerpMarket[]>;
    getBabylonOpenPerpPositions(): Promise<BabylonPerpPosition[]>;
    closeBabylonPerpPosition(
      positionId: string,
    ): Promise<BabylonPerpTradeResult>;

    // Babylon social
    getBabylonPosts(opts?: {
      page?: number;
      limit?: number;
      feed?: string;
    }): Promise<BabylonPostsResponse>;
    createBabylonPost(
      content: string,
      marketId?: string,
    ): Promise<BabylonPostResult>;
    commentOnBabylonPost(
      postId: string,
      content: string,
    ): Promise<BabylonPostResult>;
    likeBabylonPost(postId: string): Promise<{ ok: boolean }>;

    // Babylon messaging
    getBabylonChats(): Promise<BabylonChatsResponse>;
    getBabylonChatMessages(
      chatId: string,
    ): Promise<BabylonChatMessagesResponse>;
    sendBabylonChatMessage(
      chatId: string,
      content: string,
    ): Promise<BabylonSendMessageResult>;
    getBabylonDM(userId: string): Promise<BabylonChat>;

    // Babylon agent management
    getBabylonAgentGoals(): Promise<BabylonAgentGoal[]>;
    getBabylonAgentStats(): Promise<BabylonAgentStats>;
    getBabylonAgentSummary(): Promise<BabylonAgentSummary>;
    getBabylonAgentRecentTrades(): Promise<BabylonActivityFeed>;
    getBabylonAgentTradingBalance(): Promise<{ balance: number }>;
    sendBabylonAgentChat(content: string): Promise<BabylonChatResponse>;
    getBabylonAgentChat(): Promise<{ messages: BabylonChatMessage[] }>;

    // Babylon feed
    getBabylonFeedForYou(): Promise<BabylonPostsResponse>;
    getBabylonFeedHot(): Promise<BabylonPostsResponse>;
    getBabylonTrades(): Promise<BabylonActivityFeed>;

    // Babylon discover & team
    discoverBabylonAgents(): Promise<BabylonTeamResponse>;
    getBabylonTeamDashboard(): Promise<Record<string, unknown>>;
    getBabylonTeamConversations(): Promise<Record<string, unknown>>;
    pauseAllBabylonAgents(): Promise<{ ok: boolean }>;
    resumeAllBabylonAgents(): Promise<{ ok: boolean }>;
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
  return this.fetch("/api/telegram-account/status");
};

ElizaClient.prototype.startTelegramAccountAuth = async function (
  this: ElizaClient,
  phone,
) {
  return this.fetch("/api/telegram-account/auth/start", {
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
  return this.fetch("/api/telegram-account/auth/submit", {
    method: "POST",
    body: JSON.stringify(input),
  });
};

ElizaClient.prototype.disconnectTelegramAccount = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/telegram-account/disconnect", {
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
// Babylon terminal methods
// ---------------------------------------------------------------------------

ElizaClient.prototype.getBabylonAgentStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/status");
};

ElizaClient.prototype.getBabylonAgentActivity = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.type) params.set("type", opts.type);
  const qs = params.toString();
  return this.fetch(
    `/api/apps/babylon@elizaos/agent/activity${qs ? `?${qs}` : ""}`,
  );
};

ElizaClient.prototype.getBabylonAgentLogs = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.type) params.set("type", opts.type);
  if (opts?.level) params.set("level", opts.level);
  const qs = params.toString();
  return this.fetch(
    `/api/apps/babylon@elizaos/agent/logs${qs ? `?${qs}` : ""}`,
  );
};

ElizaClient.prototype.getBabylonAgentWallet = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/wallet");
};

ElizaClient.prototype.getBabylonTeam = async function (this: ElizaClient) {
  return this.fetch("/api/apps/babylon/team");
};

ElizaClient.prototype.getBabylonTeamChat = async function (this: ElizaClient) {
  return this.fetch("/api/apps/babylon/team/info");
};

ElizaClient.prototype.sendBabylonTeamChat = async function (
  this: ElizaClient,
  content,
  mentions?,
) {
  return this.fetch("/api/apps/babylon/team/chat", {
    method: "POST",
    body: JSON.stringify({ content, mentions }),
  });
};

ElizaClient.prototype.toggleBabylonAgent = async function (
  this: ElizaClient,
  action,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/toggle", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
};

ElizaClient.prototype.toggleBabylonAgentAutonomy = async function (
  this: ElizaClient,
  opts,
) {
  return this.fetch("/api/apps/babylon", {
    method: "POST",
    body: JSON.stringify(opts),
  });
};

// ---------------------------------------------------------------------------
// Babylon markets
// ---------------------------------------------------------------------------

ElizaClient.prototype.getBabylonPredictionMarkets = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
  if (opts?.status) params.set("status", opts.status);
  if (opts?.category) params.set("category", opts.category);
  const qs = params.toString();
  return this.fetch(
    `/api/apps/babylon/markets/predictions${qs ? `?${qs}` : ""}`,
  );
};

ElizaClient.prototype.getBabylonPredictionMarket = async function (
  this: ElizaClient,
  marketId,
) {
  return this.fetch(
    `/api/apps/babylon/markets/predictions/${encodeURIComponent(marketId)}`,
  );
};

ElizaClient.prototype.buyBabylonPredictionShares = async function (
  this: ElizaClient,
  marketId,
  side,
  amount,
) {
  return this.fetch(
    `/api/apps/babylon/markets/predictions/${encodeURIComponent(marketId)}/buy`,
    { method: "POST", body: JSON.stringify({ side, amount }) },
  );
};

ElizaClient.prototype.sellBabylonPredictionShares = async function (
  this: ElizaClient,
  marketId,
  side,
  amount,
) {
  return this.fetch(
    `/api/apps/babylon/markets/predictions/${encodeURIComponent(marketId)}/sell`,
    { method: "POST", body: JSON.stringify({ side, amount }) },
  );
};

ElizaClient.prototype.getBabylonPerpMarkets = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon/markets/perps");
};

ElizaClient.prototype.getBabylonOpenPerpPositions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon/markets/perps/open");
};

ElizaClient.prototype.closeBabylonPerpPosition = async function (
  this: ElizaClient,
  positionId,
) {
  return this.fetch(
    `/api/apps/babylon/markets/perps/position/${encodeURIComponent(positionId)}/close`,
    { method: "POST", body: JSON.stringify({}) },
  );
};

// ---------------------------------------------------------------------------
// Babylon social
// ---------------------------------------------------------------------------

ElizaClient.prototype.getBabylonPosts = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.page) params.set("page", String(opts.page));
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.feed) params.set("feed", opts.feed);
  const qs = params.toString();
  return this.fetch(`/api/apps/babylon/posts${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.createBabylonPost = async function (
  this: ElizaClient,
  content,
  marketId?,
) {
  return this.fetch("/api/apps/babylon/posts", {
    method: "POST",
    body: JSON.stringify({ content, marketId }),
  });
};

ElizaClient.prototype.commentOnBabylonPost = async function (
  this: ElizaClient,
  postId,
  content,
) {
  return this.fetch(
    `/api/apps/babylon/posts/${encodeURIComponent(postId)}/comments`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
};

ElizaClient.prototype.likeBabylonPost = async function (
  this: ElizaClient,
  postId,
) {
  return this.fetch(
    `/api/apps/babylon/posts/${encodeURIComponent(postId)}/like`,
    { method: "POST" },
  );
};

// ---------------------------------------------------------------------------
// Babylon messaging
// ---------------------------------------------------------------------------

ElizaClient.prototype.getBabylonChats = async function (this: ElizaClient) {
  return this.fetch("/api/apps/babylon/chats");
};

ElizaClient.prototype.getBabylonChatMessages = async function (
  this: ElizaClient,
  chatId,
) {
  return this.fetch(
    `/api/apps/babylon/chats/${encodeURIComponent(chatId)}/messages`,
  );
};

ElizaClient.prototype.sendBabylonChatMessage = async function (
  this: ElizaClient,
  chatId,
  content,
) {
  return this.fetch(
    `/api/apps/babylon/chats/${encodeURIComponent(chatId)}/message`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
};

ElizaClient.prototype.getBabylonDM = async function (
  this: ElizaClient,
  userId,
) {
  return this.fetch(
    `/api/apps/babylon/chats/dm?userId=${encodeURIComponent(userId)}`,
  );
};

// ---------------------------------------------------------------------------
// Babylon agent management
// ---------------------------------------------------------------------------

ElizaClient.prototype.getBabylonAgentGoals = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/goals");
};

ElizaClient.prototype.getBabylonAgentStats = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/stats");
};

ElizaClient.prototype.getBabylonAgentSummary = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/summary");
};

ElizaClient.prototype.getBabylonAgentRecentTrades = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/recent-trades");
};

ElizaClient.prototype.getBabylonAgentTradingBalance = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/trading-balance");
};

ElizaClient.prototype.sendBabylonAgentChat = async function (
  this: ElizaClient,
  content,
) {
  return this.fetch("/api/apps/babylon@elizaos/agent/chat", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
};

ElizaClient.prototype.getBabylonAgentChat = async function (this: ElizaClient) {
  return this.fetch("/api/apps/babylon@elizaos/agent/chat");
};

// ---------------------------------------------------------------------------
// Babylon feed
// ---------------------------------------------------------------------------

ElizaClient.prototype.getBabylonFeedForYou = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon/feed/for-you");
};

ElizaClient.prototype.getBabylonFeedHot = async function (this: ElizaClient) {
  return this.fetch("/api/apps/babylon/feed/hot");
};

ElizaClient.prototype.getBabylonTrades = async function (this: ElizaClient) {
  return this.fetch("/api/apps/babylon/trades");
};

// ---------------------------------------------------------------------------
// Babylon discover & team management
// ---------------------------------------------------------------------------

ElizaClient.prototype.discoverBabylonAgents = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon@elizaos/agents/discover");
};

ElizaClient.prototype.getBabylonTeamDashboard = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon/team/dashboard");
};

ElizaClient.prototype.getBabylonTeamConversations = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon/team/conversations");
};

ElizaClient.prototype.pauseAllBabylonAgents = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon/admin@elizaos/agents/pause-all", {
    method: "POST",
  });
};

ElizaClient.prototype.resumeAllBabylonAgents = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/apps/babylon/admin@elizaos/agents/resume-all", {
    method: "POST",
  });
};

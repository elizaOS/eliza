/**
 * Skills domain methods — skills, catalog, marketplace, apps, Babylon,
 * custom actions, WhatsApp, agent events.
 */
import type { AppPermissionsView, CustomActionDef } from "@elizaos/shared";
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
declare module "./client-base" {
  interface ElizaClient {
    getSkills(): Promise<{
      skills: SkillInfo[];
    }>;
    refreshSkills(): Promise<{
      ok: boolean;
      skills: SkillInfo[];
    }>;
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
    getSkillCatalogDetail(slug: string): Promise<{
      skill: CatalogSkill;
    }>;
    refreshSkillCatalog(): Promise<{
      ok: boolean;
      count: number;
    }>;
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
    getRegistryPluginInfo(name: string): Promise<{
      plugin: RegistryPlugin;
    }>;
    getInstalledPlugins(): Promise<{
      count: number;
      plugins: InstalledPlugin[];
    }>;
    installRegistryPlugin(
      name: string,
      autoRestart?: boolean,
      options?: {
        stream?: "latest" | "beta";
        version?: string;
      },
    ): Promise<PluginInstallResult>;
    updateRegistryPlugin(
      name: string,
      autoRestart?: boolean,
      options?: {
        stream?: "latest" | "beta";
        version?: string;
      },
    ): Promise<PluginInstallResult>;
    uninstallRegistryPlugin(
      name: string,
      autoRestart?: boolean,
    ): Promise<
      PluginMutationResult & {
        pluginName: string;
      }
    >;
    searchSkillsMarketplace(
      query: string,
      installed: boolean,
      limit: number,
    ): Promise<{
      results: SkillMarketplaceResult[];
    }>;
    getSkillsMarketplaceConfig(): Promise<{
      keySet: boolean;
    }>;
    updateSkillsMarketplaceConfig(apiKey: string): Promise<{
      keySet: boolean;
    }>;
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
    ): Promise<{
      ok: boolean;
      skill: SkillInfo;
      path: string;
    }>;
    openSkill(id: string): Promise<{
      ok: boolean;
      path: string;
    }>;
    getSkillSource(id: string): Promise<{
      ok: boolean;
      skillId: string;
      content: string;
      path: string;
    }>;
    saveSkillSource(
      id: string,
      content: string,
    ): Promise<{
      ok: boolean;
      skillId: string;
      skill: SkillInfo;
    }>;
    deleteSkill(id: string): Promise<{
      ok: boolean;
      skillId: string;
      source: string;
    }>;
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
    heartbeatAppRun(runId: string): Promise<{
      ok: boolean;
      run: AppRunSummary;
    }>;
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
    generateCustomAction(prompt: string): Promise<{
      ok: boolean;
      generated: Record<string, unknown>;
    }>;
    getWhatsAppStatus(
      accountId?: string,
      options?: {
        authScope?: "platform" | "lifeops";
      },
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
      options?: {
        authScope?: "platform" | "lifeops";
      },
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
    disconnectDiscordLocal(): Promise<{
      ok: boolean;
    }>;
    listDiscordLocalGuilds(): Promise<{
      guilds: Array<{
        id: string;
        name: string;
      }>;
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
    likeBabylonPost(postId: string): Promise<{
      ok: boolean;
    }>;
    getBabylonChats(): Promise<BabylonChatsResponse>;
    getBabylonChatMessages(
      chatId: string,
    ): Promise<BabylonChatMessagesResponse>;
    sendBabylonChatMessage(
      chatId: string,
      content: string,
    ): Promise<BabylonSendMessageResult>;
    getBabylonDM(userId: string): Promise<BabylonChat>;
    getBabylonAgentGoals(): Promise<BabylonAgentGoal[]>;
    getBabylonAgentStats(): Promise<BabylonAgentStats>;
    getBabylonAgentSummary(): Promise<BabylonAgentSummary>;
    getBabylonAgentRecentTrades(): Promise<BabylonActivityFeed>;
    getBabylonAgentTradingBalance(): Promise<{
      balance: number;
    }>;
    sendBabylonAgentChat(content: string): Promise<BabylonChatResponse>;
    getBabylonAgentChat(): Promise<{
      messages: BabylonChatMessage[];
    }>;
    getBabylonFeedForYou(): Promise<BabylonPostsResponse>;
    getBabylonFeedHot(): Promise<BabylonPostsResponse>;
    getBabylonTrades(): Promise<BabylonActivityFeed>;
    discoverBabylonAgents(): Promise<BabylonTeamResponse>;
    getBabylonTeamDashboard(): Promise<Record<string, unknown>>;
    getBabylonTeamConversations(): Promise<Record<string, unknown>>;
    pauseAllBabylonAgents(): Promise<{
      ok: boolean;
    }>;
    resumeAllBabylonAgents(): Promise<{
      ok: boolean;
    }>;
  }
}
//# sourceMappingURL=client-skills.d.ts.map

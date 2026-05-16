/**
 * Cloud domain methods — cloud billing, compat agents, sandbox,
 * export/import, direct cloud auth, bug reports.
 */
import type {
  CloudBillingCheckoutRequest,
  CloudBillingCheckoutResponse,
  CloudBillingCryptoQuoteRequest,
  CloudBillingCryptoQuoteResponse,
  CloudBillingHistoryItem,
  CloudBillingPaymentMethod,
  CloudBillingSettings,
  CloudBillingSettingsUpdateRequest,
  CloudBillingSummary,
  CloudCompatAgent,
  CloudCompatAgentProvisionResponse,
  CloudCompatAgentStatus,
  CloudCompatDiscordConfig,
  CloudCompatJob,
  CloudCompatLaunchResult,
  CloudCompatManagedDiscordStatus,
  CloudCompatManagedGithubStatus,
  CloudCredits,
  CloudLoginPersistResponse,
  CloudLoginPollResponse,
  CloudLoginResponse,
  CloudOAuthConnection,
  CloudOAuthConnectionRole,
  CloudOAuthInitiateResponse,
  CloudStatus,
  CloudTwitterOAuthInitiateResponse,
  SandboxBrowserEndpoints,
  SandboxPlatformStatus,
  SandboxScreenshotPayload,
  SandboxScreenshotRegion,
  SandboxStartResponse,
  SandboxWindowInfo,
} from "./client-types";

type ProvisioningAgentStatusData = {
  status?: string;
  bridgeUrl?: string | null;
  webUiUrl?: string | null;
  agentId?: string | null;
};
type ProvisioningAgentChatMessage = {
  role: "user" | "assistant";
  content: string;
};
type ProvisioningAgentChatData = {
  reply?: string;
  containerStatus?: string;
  bridgeUrl?: string | null;
  webUiUrl?: string | null;
  agentId?: string | null;
  history?: ProvisioningAgentChatMessage[];
};
declare module "./client-base" {
  interface ElizaClient {
    getCloudStatus(): Promise<CloudStatus>;
    getCloudCredits(): Promise<CloudCredits>;
    getCloudBillingSummary(): Promise<CloudBillingSummary>;
    getCloudBillingSettings(): Promise<CloudBillingSettings>;
    updateCloudBillingSettings(
      request: CloudBillingSettingsUpdateRequest,
    ): Promise<CloudBillingSettings>;
    getCloudBillingPaymentMethods(): Promise<{
      success?: boolean;
      data?: CloudBillingPaymentMethod[];
      items?: CloudBillingPaymentMethod[];
      paymentMethods?: CloudBillingPaymentMethod[];
      [key: string]: unknown;
    }>;
    getCloudBillingHistory(): Promise<{
      success?: boolean;
      data?: CloudBillingHistoryItem[];
      items?: CloudBillingHistoryItem[];
      history?: CloudBillingHistoryItem[];
      [key: string]: unknown;
    }>;
    createCloudBillingCheckout(
      request: CloudBillingCheckoutRequest,
    ): Promise<CloudBillingCheckoutResponse>;
    createCloudBillingCryptoQuote(
      request: CloudBillingCryptoQuoteRequest,
    ): Promise<CloudBillingCryptoQuoteResponse>;
    cloudLogin(): Promise<CloudLoginResponse>;
    cloudLoginPoll(sessionId: string): Promise<CloudLoginPollResponse>;
    cloudLoginPersist(
      apiKey: string,
      identity?: {
        organizationId?: string;
        userId?: string;
      },
    ): Promise<CloudLoginPersistResponse>;
    cloudDisconnect(): Promise<{
      ok: boolean;
    }>;
    getCloudCompatAgents(): Promise<{
      success: boolean;
      data: CloudCompatAgent[];
    }>;
    createCloudCompatAgent(opts: {
      agentName: string;
      agentConfig?: Record<string, unknown>;
      environmentVars?: Record<string, string>;
    }): Promise<{
      success: boolean;
      data: {
        agentId: string;
        agentName: string;
        jobId: string;
        status: string;
        nodeId: string | null;
        message: string;
      };
    }>;
    ensureCloudCompatManagedDiscordAgent(): Promise<{
      success: boolean;
      data: {
        agent: CloudCompatAgent;
        created: boolean;
      };
    }>;
    provisionCloudCompatAgent(
      agentId: string,
    ): Promise<CloudCompatAgentProvisionResponse>;
    getCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatAgent;
    }>;
    getCloudCompatAgentManagedDiscord(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedDiscordStatus;
    }>;
    createCloudCompatAgentManagedDiscordOauth(
      agentId: string,
      request?: {
        returnUrl?: string;
        botNickname?: string;
      },
    ): Promise<{
      success: boolean;
      data: {
        authorizeUrl: string;
        applicationId: string | null;
      };
    }>;
    disconnectCloudCompatAgentManagedDiscord(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedDiscordStatus;
    }>;
    getCloudCompatAgentDiscordConfig(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatDiscordConfig;
    }>;
    updateCloudCompatAgentDiscordConfig(
      agentId: string,
      config: CloudCompatDiscordConfig,
    ): Promise<{
      success: boolean;
      data: CloudCompatDiscordConfig;
    }>;
    getCloudCompatAgentManagedGithub(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    createCloudCompatAgentManagedGithubOauth(
      agentId: string,
      request?: {
        scopes?: string[];
        postMessage?: boolean;
        returnUrl?: string;
      },
    ): Promise<{
      success: boolean;
      data: {
        authorizeUrl: string;
      };
    }>;
    linkCloudCompatAgentManagedGithub(
      agentId: string,
      connectionId: string,
    ): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    disconnectCloudCompatAgentManagedGithub(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    listCloudOauthConnections(args?: {
      platform?: string;
      connectionRole?: CloudOAuthConnectionRole;
    }): Promise<{
      connections: CloudOAuthConnection[];
    }>;
    initiateCloudOauth(
      platform: string,
      request?: {
        redirectUrl?: string;
        scopes?: string[];
        connectionRole?: CloudOAuthConnectionRole;
      },
    ): Promise<CloudOAuthInitiateResponse>;
    initiateCloudTwitterOauth(request?: {
      redirectUrl?: string;
      connectionRole?: CloudOAuthConnectionRole;
    }): Promise<CloudTwitterOAuthInitiateResponse>;
    disconnectCloudOauthConnection(connectionId: string): Promise<{
      success?: boolean;
      error?: string;
      [key: string]: unknown;
    }>;
    getCloudCompatAgentGithubToken(agentId: string): Promise<{
      success: boolean;
      data: {
        accessToken: string;
        githubUsername: string;
      };
    }>;
    deleteCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: {
        jobId: string;
        status: string;
        message: string;
      };
    }>;
    getCloudCompatAgentStatus(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatAgentStatus;
    }>;
    getProvisioningAgentStatus(agentId?: string): Promise<{
      success: boolean;
      data: ProvisioningAgentStatusData;
    }>;
    sendProvisioningAgentMessage(
      message: string,
      agentId?: string,
    ): Promise<{
      success: boolean;
      data: ProvisioningAgentChatData;
    }>;
    getCloudCompatAgentLogs(
      agentId: string,
      tail?: number,
    ): Promise<{
      success: boolean;
      data: string;
    }>;
    restartCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: {
        jobId: string;
        status: string;
        message: string;
      };
    }>;
    suspendCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: {
        jobId: string;
        status: string;
        message: string;
      };
    }>;
    resumeCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: {
        jobId: string;
        status: string;
        message: string;
      };
    }>;
    launchCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data?: CloudCompatLaunchResult;
      error?: string;
    }>;
    /** Fetch a pairing token for a cloud agent (for opening Web UI in a new tab). */
    getCloudCompatPairingToken(agentId: string): Promise<{
      success: boolean;
      data: {
        token: string;
        redirectUrl: string;
        expiresIn: number;
      };
    }>;
    getCloudCompatAvailability(): Promise<{
      success: boolean;
      data: {
        totalSlots: number;
        usedSlots: number;
        availableSlots: number;
        acceptingNewAgents: boolean;
      };
    }>;
    getCloudCompatJobStatus(jobId: string): Promise<{
      success: boolean;
      data: CloudCompatJob;
    }>;
    exportAgent(password: string, includeLogs?: boolean): Promise<Response>;
    getExportEstimate(): Promise<{
      estimatedBytes: number;
      memoriesCount: number;
      entitiesCount: number;
      roomsCount: number;
      worldsCount: number;
      tasksCount: number;
    }>;
    importAgent(
      password: string,
      fileBuffer: ArrayBuffer,
    ): Promise<{
      success: boolean;
      agentId: string;
      agentName: string;
      counts: Record<string, number>;
    }>;
    getSandboxPlatform(): Promise<SandboxPlatformStatus>;
    getSandboxBrowser(): Promise<SandboxBrowserEndpoints>;
    getSandboxScreenshot(
      region?: SandboxScreenshotRegion,
    ): Promise<SandboxScreenshotPayload>;
    getSandboxWindows(): Promise<{
      windows: SandboxWindowInfo[];
      error?: string;
    }>;
    startDocker(): Promise<SandboxStartResponse>;
    cloudLoginDirect(cloudApiBase: string): Promise<{
      ok: boolean;
      apiBase?: string;
      browserUrl?: string;
      sessionId?: string;
      error?: string;
    }>;
    cloudLoginPollDirect(
      cloudApiBase: string,
      sessionId: string,
    ): Promise<{
      status: "pending" | "authenticated" | "expired" | "error";
      organizationId?: string;
      token?: string;
      userId?: string;
      error?: string;
    }>;
    provisionCloudSandbox(options: {
      cloudApiBase: string;
      authToken: string;
      name: string;
      bio?: string[];
      onProgress?: (status: string, detail?: string) => void;
    }): Promise<{
      bridgeUrl: string;
      agentId: string;
    }>;
    checkBugReportInfo(): Promise<{
      nodeVersion?: string;
      platform?: string;
      submissionMode?: "remote" | "github" | "fallback";
    }>;
    submitBugReport(report: {
      description: string;
      stepsToReproduce: string;
      expectedBehavior?: string;
      actualBehavior?: string;
      environment?: string;
      nodeVersion?: string;
      modelProvider?: string;
      logs?: string;
      category?: "general" | "startup-failure";
      appVersion?: string;
      releaseChannel?: string;
      startup?: {
        reason?: string;
        phase?: string;
        message?: string;
        detail?: string;
        status?: number;
        path?: string;
      };
    }): Promise<{
      accepted?: boolean;
      id?: string;
      url?: string;
      fallback?: string;
      destination?: "remote" | "github" | "fallback";
    }>;
  }
}
//# sourceMappingURL=client-cloud.d.ts.map

/**
 * N8N Credential Bridge
 *
 * Bridges cloud credentials to plugin-workflow's CredentialProvider interface.
 * This service does NOT touch the n8n API.
 *
 * Two resolution strategies (mutually exclusive):
 *
 * - **OAuth credentials** (Gmail, Slack, etc.) — maps the n8n credential type
 *   to a cloud platform, checks if connected, returns token data or auth URL.
 *
 * - **API key credentials** (openAiApi) — reads the user's cloud API key
 *   and returns it with the proxy URL. No auth flow needed.
 *
 * The plugin then uses the credential data to create the n8n credential itself
 * via its own apiClient.createCredential().
 *
 * Registered as serviceType "workflow_credential_provider" — the plugin discovers it
 * via runtime.getService("workflow_credential_provider").
 */

import { type IAgentRuntime, Service } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { dbRead } from "@/db/client";
import { platformCredentials } from "@/db/schemas/platform-credentials";
import { isUserLookupError, lookupUser } from "@/lib/eliza/plugin-oauth/utils";
import { apiKeysService } from "@/lib/services/api-keys";
import { elizaAppConfig } from "@/lib/services/eliza-app/config";
import { oauthService } from "@/lib/services/oauth";
import { getClientId, getClientSecret, getProvider } from "@/lib/services/oauth/provider-registry";
import { secretsService } from "@/lib/services/secrets";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { logger } from "@/lib/utils/logger";
import { API_KEY_CRED_TYPES } from "./apikey-cred-map";
import { mapCredTypeToCloudPlatform } from "./oauth-cred-map";

const SERVICE_TYPE = "workflow_credential_provider";

const TELEGRAM_CRED_TYPES = new Set(["telegramApi"]);

/**
 * Result type matching plugin-workflow's CredentialProviderResult.
 * Duplicated here to avoid a direct dependency on the plugin package.
 */
type CredentialProviderResult =
  | { status: "credential_data"; data: Record<string, unknown> }
  | { status: "needs_auth"; authUrl: string }
  | null;

export class WorkflowCredentialBridge extends Service {
  static serviceType = SERVICE_TYPE;
  capabilityDescription =
    "Bridges cloud credentials (OAuth + API keys) to n8n workflow credentials";

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new WorkflowCredentialBridge(runtime);
    logger.info("[WorkflowCredentialBridge] Bridge active");
    return service;
  }

  static async stop(): Promise<void> {}
  async stop(): Promise<void> {}

  /**
   * Dispatch to the correct resolution strategy based on credential type.
   *
   * Called by plugin-workflow's credentialResolver during workflow deployment.
   * Returns credential data — the plugin creates the n8n credential itself.
   */
  async resolve(userId: string, credType: string): Promise<CredentialProviderResult> {
    const platform = mapCredTypeToCloudPlatform(credType);
    if (platform) return this.resolveOAuthCredential(credType, platform, userId);

    if (credType in API_KEY_CRED_TYPES) return this.resolveApiKeyCredential(credType, userId);

    if (TELEGRAM_CRED_TYPES.has(credType)) return this.resolveTelegramCredential(userId);

    return null;
  }

  // ── Batch credential type check ────────────────────────────────────────

  /**
   * Check which credential types are supported by the cloud platform.
   * Synchronous — pure in-memory prefix matching + object key lookup.
   * Used by the plugin's early integration availability check (spec 09).
   */
  checkCredentialTypes(credTypes: string[]): {
    supported: string[];
    unsupported: string[];
  } {
    const supported: string[] = [];
    const unsupported: string[] = [];

    for (const credType of credTypes) {
      if (
        mapCredTypeToCloudPlatform(credType) !== null ||
        credType in API_KEY_CRED_TYPES ||
        TELEGRAM_CRED_TYPES.has(credType)
      ) {
        supported.push(credType);
      } else {
        unsupported.push(credType);
      }
    }

    logger.info("[WorkflowCredentialBridge] checkCredentialTypes", {
      requested: credTypes,
      supported,
      unsupported,
    });

    return { supported, unsupported };
  }

  // ── OAuth strategy ──────────────────────────────────────────────────────

  /**
   * Resolve OAuth credential types (gmail, slack, github, etc.).
   * Returns token data if connected, auth URL if not.
   */
  private async resolveOAuthCredential(
    credType: string,
    platform: string,
    userId: string,
  ): Promise<CredentialProviderResult> {
    const provider = getProvider(platform);
    if (!provider) return null;

    const userResult = await lookupUser(userId, "N8N_CREDENTIAL_BRIDGE");
    if (isUserLookupError(userResult)) {
      logger.warn("[WorkflowCredentialBridge] User lookup failed", { userId });
      return null;
    }
    const { user, organizationId } = userResult;

    const connected = await oauthService.isPlatformConnected(organizationId, platform);

    if (!connected) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
      const result = await oauthService.initiateAuth({
        organizationId,
        userId: user.id,
        platform,
        redirectUrl: `${baseUrl}/dashboard/settings?tab=connections`,
      });
      return { status: "needs_auth", authUrl: result.authUrl };
    }

    let token: { accessToken: string; expiresAt?: Date };
    let connectionId: string;
    try {
      ({ token, connectionId } = await oauthService.getValidTokenByPlatformWithConnectionId({
        organizationId,
        platform,
      }));
    } catch (error) {
      // Connection revoked between isPlatformConnected check and token retrieval
      logger.warn("[WorkflowCredentialBridge] Token retrieval failed after connection check", {
        platform,
        error: error instanceof Error ? error.message : String(error),
      });
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
      const result = await oauthService.initiateAuth({
        organizationId,
        userId: user.id,
        platform,
        redirectUrl: `${baseUrl}/dashboard/settings?tab=connections`,
      });
      return { status: "needs_auth", authUrl: result.authUrl };
    }

    // Get refresh token from secrets via platform_credentials row
    const [credential] = await dbRead
      .select({
        refreshTokenSecretId: platformCredentials.refresh_token_secret_id,
      })
      .from(platformCredentials)
      .where(eq(platformCredentials.id, connectionId))
      .limit(1);

    let refreshToken: string | undefined;
    if (credential?.refreshTokenSecretId) {
      refreshToken = await secretsService.getDecryptedValue(
        credential.refreshTokenSecretId,
        organizationId,
        {
          actorType: "system",
          actorId: SERVICE_TYPE,
          source: "n8n-credential-bridge",
        },
      );
    } else {
      logger.debug("[WorkflowCredentialBridge] No refresh token for connection", {
        connectionId,
        platform,
      });
    }

    const clientId = getClientId(provider);
    const clientSecret = getClientSecret(provider);

    const oauthTokenData: Record<string, unknown> = {
      access_token: token.accessToken,
      token_type: "Bearer",
    };

    if (refreshToken) {
      oauthTokenData.refresh_token = refreshToken;
    }
    if (token.expiresAt) {
      oauthTokenData.expiry_date = token.expiresAt.getTime();
    }

    logger.info("[WorkflowCredentialBridge] OAuth credential resolved", {
      credType,
      platform,
    });

    return {
      status: "credential_data",
      data: {
        clientId,
        clientSecret,
        oauthTokenData,
        // n8n schema requires these fields (validated via allOf conditionals)
        serverUrl: "",
        sendAdditionalBodyProperties: false,
        additionalBodyProperties: {},
      },
    };
  }

  // ── API key strategy ────────────────────────────────────────────────────

  /**
   * Resolve API key credential types (e.g. openAiApi).
   * Returns credential data with the user's cloud API key + proxy URL.
   */
  private async resolveApiKeyCredential(
    credType: string,
    userId: string,
  ): Promise<CredentialProviderResult> {
    const mapping = API_KEY_CRED_TYPES[credType];

    const userResult = await lookupUser(userId, "N8N_CREDENTIAL_BRIDGE");
    if (isUserLookupError(userResult)) {
      logger.warn("[WorkflowCredentialBridge] User lookup failed", { userId });
      return null;
    }
    const { user, organizationId } = userResult;

    const apiKey = await this.getUserApiKey(user.id, organizationId);
    if (!apiKey) return null;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

    logger.info("[WorkflowCredentialBridge] API key credential resolved", {
      credType,
    });

    return {
      status: "credential_data",
      data: mapping.buildData(apiKey, baseUrl),
    };
  }

  // ── Telegram bot token strategy ──────────────────────────────────────

  /**
   * Resolve Telegram bot token credential.
   * Uses the Eliza App bot token (env var) or the org's stored bot token.
   * n8n's telegramApi credential expects { accessToken: botToken }.
   */
  private async resolveTelegramCredential(userId: string): Promise<CredentialProviderResult> {
    const userResult = await lookupUser(userId, "N8N_CREDENTIAL_BRIDGE");
    if (isUserLookupError(userResult)) {
      logger.warn("[WorkflowCredentialBridge] User lookup failed, cannot resolve Telegram credential", {
        userId,
      });
      return null;
    }

    const orgBotToken = await telegramAutomationService.getBotToken(userResult.organizationId);
    if (orgBotToken) {
      logger.info("[WorkflowCredentialBridge] Telegram credential resolved from org bot token");
      return {
        status: "credential_data",
        data: { accessToken: orgBotToken },
      };
    }

    const appBotToken = elizaAppConfig.telegram.botToken;
    if (appBotToken) {
      logger.info(
        "[WorkflowCredentialBridge] Telegram credential resolved from app bot token (fallback)",
      );
      return {
        status: "credential_data",
        data: { accessToken: appBotToken },
      };
    }

    logger.warn("[WorkflowCredentialBridge] No Telegram bot token available", {
      userId,
    });
    return null;
  }

  /**
   * Get the user's active, non-expired cloud API key.
   * Every user has one (auto-created on signup via ensureUserHasApiKey).
   */
  private async getUserApiKey(userId: string, organizationId: string): Promise<string | null> {
    const keys = await apiKeysService.listByOrganization(organizationId);
    const now = new Date();
    const userKey = keys.find(
      (k) => k.user_id === userId && k.is_active && (!k.expires_at || k.expires_at > now),
    );

    if (!userKey) {
      logger.warn("[WorkflowCredentialBridge] No active API key found", {
        userId,
        organizationId,
      });
      return null;
    }

    return userKey.key;
  }
}

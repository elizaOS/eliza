/** Resolves the Cloud schedule-sync configuration from the effective operational Eliza config for the sync client. */
import { loadEffectiveElizaConfig } from "@elizaos/agent";
import {
  normalizeLifeOpsScheduleSyncSecret,
  type ResolvedLifeOpsScheduleSyncConfig,
  resolveLifeOpsScheduleSyncConfig,
} from "@elizaos/plugin-elizacloud/cloud/lifeops-schedule-sync-client";
import {
  resolveCloudApiBaseUrl,
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";

export function resolveLifeOpsScheduleSyncConfigFromElizaConfig(): ResolvedLifeOpsScheduleSyncConfig {
  if (resolveDevCloudEnvAuthority()) {
    const apiKey = normalizeLifeOpsScheduleSyncSecret(
      resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_API_KEY"),
    );
    const agentId = normalizeLifeOpsScheduleSyncSecret(
      resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_AGENT_ID"),
    );
    if (!apiKey || !agentId) {
      return { configured: false, mode: "none" };
    }
    return {
      configured: true,
      mode: "cloud",
      apiBaseUrl: resolveCloudApiBaseUrl(
        resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_BASE_URL"),
      ),
      apiKey,
      agentId,
    };
  }

  try {
    const config = loadEffectiveElizaConfig();
    const cloud =
      config.cloud && typeof config.cloud === "object"
        ? (config.cloud as Record<string, unknown>)
        : null;
    return resolveLifeOpsScheduleSyncConfig({
      remoteApiBase:
        cloud && typeof cloud.remoteApiBase === "string"
          ? cloud.remoteApiBase
          : null,
      remoteAccessToken:
        cloud && typeof cloud.remoteAccessToken === "string"
          ? cloud.remoteAccessToken
          : null,
      apiKey: cloud && typeof cloud.apiKey === "string" ? cloud.apiKey : null,
      baseUrl:
        cloud && typeof cloud.baseUrl === "string" ? cloud.baseUrl : null,
      agentId:
        cloud && typeof cloud.agentId === "string" ? cloud.agentId : null,
    });
  } catch {
    return resolveLifeOpsScheduleSyncConfig();
  }
}

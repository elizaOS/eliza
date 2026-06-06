import { loadElizaConfig } from "@elizaos/agent";
import {
  type ResolvedLifeOpsScheduleSyncConfig,
  resolveLifeOpsScheduleSyncConfig,
} from "@elizaos/plugin-elizacloud/cloud/lifeops-schedule-sync-client";

export function resolveLifeOpsScheduleSyncConfigFromElizaConfig(): ResolvedLifeOpsScheduleSyncConfig {
  try {
    const config = loadElizaConfig();
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

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getProjectId } from "./utils/config";

export interface PluginConfig {
  readonly GOOGLE_VERTEX_PROJECT_ID?: string;
  readonly GOOGLE_VERTEX_REGION?: string;
  readonly VERTEX_SMALL_MODEL?: string;
  readonly VERTEX_LARGE_MODEL?: string;
  readonly VERTEX_REASONING_SMALL_MODEL?: string;
  readonly VERTEX_REASONING_LARGE_MODEL?: string;
}

export function initializeVertex(
  _config: PluginConfig,
  runtime: IAgentRuntime,
): void {
  const projectId = getProjectId(runtime);
  if (!projectId) {
    logger.warn(
      "[Vertex] GOOGLE_VERTEX_PROJECT_ID is not set. Vertex AI plugin will not work.",
    );
    return;
  }
  logger.log(`[Vertex] Configured for project: ${projectId}`);
}

/**
 * Runtime Factory compatibility barrel.
 *
 * RuntimeFactory still calls waitForMcpServiceIfNeeded; MCP service waiting
 * still calls waitForInitialization in runtime/mcp-service-wait.ts.
 */
import { runtimeFactory } from "./runtime/initializer";
import { registerRuntimeCacheActions } from "./runtime-cache-registry";

export {
  getStaticEmbeddingDimension,
  KNOWN_EMBEDDING_DIMENSIONS,
} from "@/lib/cache/edge-runtime-cache";
export {
  _testing,
  DEFAULT_AGENT_ID_STRING,
  getRuntimeCacheStats,
  invalidateByOrganization,
  invalidateRuntime,
  isRuntimeCached,
  RuntimeFactory,
  runtimeFactory,
} from "./runtime/initializer";

registerRuntimeCacheActions({
  invalidateRuntime: (agentId: string) => runtimeFactory.invalidateRuntime(agentId),
  invalidateByOrganization: (organizationId: string) =>
    runtimeFactory.invalidateByOrganization(organizationId),
});

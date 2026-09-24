/** Exposes the shared runtime helpers used by orchestrator tests without loading the generated-data barrel. */
export * from "@elizaos/core/contracts/coding-agent-capabilities";
export * from "@elizaos/plugin-elizacloud/cloud-config/dev-cloud-env-authority";
export {
  isAndroidMobile,
  resolvePlatform,
} from "@elizaos/core/runtime-env";
export { readAliasedEnv } from "@elizaos/core/utils/env";

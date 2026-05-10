/**
 * Re-export shim for the canonical runtime execution-mode resolvers.
 *
 * The shared package owns the source of truth (`@elizaos/shared`'s
 * `config/runtime-mode.ts`) because it is the inward-most layer that both
 * `@elizaos/agent` and the plugins (`plugin-shell`, `plugin-coding-tools`)
 * can depend on without creating a cycle. This file keeps the historical
 * import path stable for callers inside the agent package.
 */

export {
  isCloudExecutionMode,
  type LocalExecutionMode,
  resolveLocalExecutionMode,
  resolveRuntimeExecutionMode,
  type RuntimeExecutionMode,
  type RuntimeExecutionModeSource,
  shouldUseSandboxExecution,
} from "@elizaos/shared";

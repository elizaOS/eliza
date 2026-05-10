// Re-export shim for `@elizaos/shared`'s runtime-execution-mode resolvers
// so callers inside the agent package can import from a stable local path.

export {
  isCloudExecutionMode,
  type LocalExecutionMode,
  type RuntimeExecutionMode,
  type RuntimeExecutionModeSource,
  resolveLocalExecutionMode,
  resolveRuntimeExecutionMode,
  shouldUseSandboxExecution,
} from "@elizaos/shared";

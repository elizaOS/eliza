import type { Plugin } from "@elizaos/core";
import { fileAction, shellAction, worktreeAction } from "./actions/index.js";
import { availableToolsProvider } from "./providers/available-tools.js";
import {
  FileStateService,
  RipgrepService,
  SandboxService,
  SessionCwdService,
} from "./services/index.js";

function terminalSupportedByEnv(
  env: Record<string, string | undefined>,
): boolean {
  const variant = (env.MILADY_BUILD_VARIANT ?? env.ELIZA_BUILD_VARIANT ?? "")
    .trim()
    .toLowerCase();
  if (variant === "store") return false;
  const platform = env.ELIZA_PLATFORM?.trim().toLowerCase();
  const mobile =
    platform === "android" ||
    platform === "ios" ||
    Boolean(env.ANDROID_ROOT || env.ANDROID_DATA);
  if (!mobile) return true;
  const mode = (
    env.ELIZA_RUNTIME_MODE ??
    env.RUNTIME_MODE ??
    env.LOCAL_RUNTIME_MODE ??
    ""
  )
    .trim()
    .toLowerCase();
  const aosp = ["1", "true", "yes", "on"].includes(
    (env.ELIZA_AOSP_BUILD ?? "").trim().toLowerCase(),
  );
  return platform === "android" && aosp && mode === "local-yolo";
}

export const codingToolsPlugin: Plugin = {
  name: "coding-tools",
  description:
    "Native Claude-Code-style coding tools. FILE owns read/write/edit/grep/glob/ls operations, SHELL runs local commands, and WORKTREE owns enter/exit worktree operations. The TODO umbrella action is provided by @elizaos/plugin-todos. WEB_SEARCH is provided by core/agent. All file paths must be absolute unless an operation explicitly defaults to session cwd. Blocks user-private + per-OS system paths by default.",
  services: [
    FileStateService,
    SandboxService,
    SessionCwdService,
    RipgrepService,
  ],
  providers: [availableToolsProvider],
  actions: [fileAction, shellAction, worktreeAction],
  // Self-declared auto-enable: activate when features.codingTools is enabled,
  // or via the legacy "coding-agent" feature key (the plugin was renamed).
  autoEnable: {
    shouldEnable: (env, config) => {
      const features = config?.features as Record<string, unknown> | undefined;
      const isFeatureEnabled = (f: unknown) =>
        f === true ||
        (typeof f === "object" &&
          f !== null &&
          (f as { enabled?: unknown }).enabled !== false);
      return (
        (isFeatureEnabled(features?.codingTools) ||
          isFeatureEnabled(features?.["coding-agent"])) &&
        terminalSupportedByEnv(env as Record<string, string | undefined>)
      );
    },
  },
};

export default codingToolsPlugin;

export { availableToolsProvider } from "./providers/available-tools.js";
export * from "./services/coding-agent-context.js";
export {
  CodingTaskExecutor,
  FileStateService,
  RipgrepService,
  SandboxService,
  SessionCwdService,
} from "./services/index.js";
export * from "./types.js";

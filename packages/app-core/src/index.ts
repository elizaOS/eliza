/**
 * Public entry point for @elizaos/app-core (shell, UI primitives, shared config).
 */

export * from "./ui";
export * from "@elizaos/shared/config";
export type { RestartHandler } from "@elizaos/shared/restart";
export {
  RESTART_EXIT_CODE,
  requestRestart,
  setRestartHandler,
} from "@elizaos/shared/restart";

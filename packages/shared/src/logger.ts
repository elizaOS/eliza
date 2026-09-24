/** Exposes the canonical Node/Bun runtime logger to shared consumers. */

export type { Logger, LoggerBindings } from "@elizaos/core";
export {
  createLogger,
  logger,
  logger as elizaLogger,
  logger as default,
} from "@elizaos/core";

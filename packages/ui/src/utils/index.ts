/**
 * Barrel for the UI utils surface: numeric parsers, formatters, and the
 * re-exported shared helpers.
 */

export { stripAssistantStageDirections } from "@elizaos/shared/utils/assistant-text";
export {
  resolveElizaPackageRoot,
  resolveElizaPackageRootSync,
} from "@elizaos/shared/utils/eliza-root";
export { isSafeExecutableValue } from "@elizaos/shared/utils/exec-safety";
export {
  type ParseClampedIntegerOptions,
  type ParseClampedNumberOptions,
  type ParsePositiveNumberOptions,
  parseClampedFloat,
  parseClampedInteger,
  parsePositiveFloat,
  parsePositiveInteger,
} from "@elizaos/shared/utils/number-parsing";
export * from "../lib/floating-layers";
export { cn } from "../lib/utils";
export * from "./asset-url";
export * from "./browser-tab-kit-types";
export * from "./browser-tabs-renderer-registry";
export * from "./character-message-examples";
export * from "./clipboard";
export * from "./cloud-status";
export * from "./desktop-bug-report";
export * from "./desktop-dialogs";
export * from "./desktop-workspace";
export * from "./documents-upload-image";
export * from "./eliza-cloud-model-route";
export * from "./eliza-globals";
export * from "./env";
export * from "./errors";
export * from "./format";
export * from "./globals";
export * from "./image-attachment";
export * from "./labels";
export * from "./log-prefix";
export * from "./name-tokens";
export * from "./namespace-defaults";
export * from "./navigation-url";
export * from "./openExternalUrl";
export * from "./owner-name";
export * from "./rate-limiter";
export * from "./serialise";
export * from "./sql-compat";
export * from "./streaming-text";
export * from "./subscription-auth";
export * from "./trajectory-format";
export * from "./transient-fetch";
export * from "./tts-debug";

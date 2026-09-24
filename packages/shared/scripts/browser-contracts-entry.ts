/**
 * Browser-safe runtime values used by renderers and shared client protocols.
 * The shared build bundles selected pure core primitives and shared view
 * policies with their declarations. Published clients never import the Node
 * runtime barrel or repository-private source paths.
 */

export * from "../../core/src/access-control/role-primitives.js";
export {
  isConnectorConfigured,
  isWechatConfigured,
} from "../../core/src/connectors/connector-config.js";
export * from "../../core/src/connectors.js";
export {
  BGE_SMALL_VECTOR_SPACE,
  identifyEmbeddingVector,
} from "../../core/src/embedding-vector-space.js";
export * from "../../core/src/env-utils.js";
export * from "../../core/src/errors.js";
export * from "../../core/src/inference-trace.js";
export * from "../../core/src/messaging/interactions/parse.js";
export {
  replaceIndexedNameTokens,
  replaceNameTokens,
} from "../../core/src/name-tokens.js";
export { getRecentMessagesData } from "../../core/src/recent-messages-state.js";
export * from "../../core/src/types/effects.js";
export * from "../../core/src/types/message-source.js";
export * from "../../core/src/types/notification.js";
export {
  buildDeterministicSeed,
  getDeterministicNames,
} from "../../core/src/utils/deterministic.js";
export { resolveEnvAlias } from "../../core/src/utils/env-alias.js";
export * from "../../core/src/utils/format-error.js";
export * from "../../core/src/utils/unicode.js";
export * from "../src/views/surface-manifest.js";
export { toSwarmActivity } from "../src/views/swarm-activity.js";
export * from "../src/views/view-kind.js";

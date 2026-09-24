/**
 * Projects audited pure kernel contracts into the application renderer.
 * This host-only adapter excludes the Node runtime barrel; new dependencies
 * require an explicit leaf export and a browser-bundle check.
 */
import { sha1 } from "@noble/hashes/legacy.js";
import { uuidFromString } from "../../../core/src/utils/uuid";

export { validateUuid } from "../../../core/src/utils/uuid";
export { createLogger, elizaLogger, logger } from "./browser-logger";
export function stringToUuid(target: string | number) {
  return uuidFromString(target, (input) =>
    sha1(new TextEncoder().encode(input)),
  );
}

export {
  ROLE_RANK,
  roleRank,
  satisfiesRoleGate,
} from "../../../core/src/access-control/role-primitives";
export {
  expandConnectorSourceFilter,
  getConnectorIdentityMetadataMapping,
  getConnectorSourceAliases,
  getConnectorSourceMetadata,
  getConnectorWorldIdMetadataKeys,
  isPassiveConnectorSource,
  normalizeConnectorSource,
  registerConnectorSourceAliases,
  registerConnectorSourceDefinitions,
  registerConnectorSourceMetadata,
  unregisterConnectorSourceMetadataOwner,
} from "../../../core/src/connectors";
export {
  isConnectorConfigured,
  isWechatConfigured,
} from "../../../core/src/connectors/connector-config";
export {
  BGE_SMALL_VECTOR_SPACE,
  identifyEmbeddingVector,
} from "../../../core/src/embedding-vector-space";
export { isTruthyEnvValue } from "../../../core/src/env-utils";
export { ElizaError } from "../../../core/src/errors";
export { isInferenceTraceId } from "../../../core/src/inference-trace";
export { stripUnclaimedInteractionMarkup } from "../../../core/src/messaging/interactions/parse";
export {
  replaceIndexedNameTokens,
  replaceNameTokens,
} from "../../../core/src/name-tokens";
export { getRecentMessagesData } from "../../../core/src/recent-messages-state";
export { normalizeEffectReceipts } from "../../../core/src/types/effects";
export {
  MESSAGE_SOURCE_AGENT_GREETING,
  MESSAGE_SOURCE_CLIENT_CHAT,
  MESSAGE_SOURCE_CODING_AGENT,
} from "../../../core/src/types/message-source";
export {
  DEFAULT_NOTIFICATION_CATEGORY,
  DEFAULT_NOTIFICATION_PRIORITY,
  tierForPriority,
} from "../../../core/src/types/notification";
export {
  IMMERSIVE_WALLPAPER_SURFACE,
  resolveSurfaceBackgroundPolicy,
  resolveSurfaceManifest,
  surfaceGrants,
} from "../../../core/src/types/surface-manifest";
export { toSwarmActivity } from "../../../core/src/types/swarm-coordinator";
export {
  dedupeModalities,
  isViewKindEnabled,
  isViewVisible,
  resolveViewKind,
} from "../../../core/src/types/view-kind";
export {
  buildDeterministicSeed,
  getDeterministicNames,
} from "../../../core/src/utils/deterministic";
export { resolveEnvAlias } from "../../../core/src/utils/env-alias";
export { formatError } from "../../../core/src/utils/format-error";
export {
  tailWellFormed,
  toWellFormedUnicode,
  truncateWellFormed,
} from "../../../core/src/utils/unicode";

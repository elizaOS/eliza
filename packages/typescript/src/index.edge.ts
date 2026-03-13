/**
 * Edge runtime entry point for @elizaos/core (Vercel Edge, Cloudflare Workers, Deno Deploy).
 * Same API as node minus Node-only modules: character-loader, sessions, plugins discovery,
 * media, network/ssrf, services/hook, provisioning, utils/node.
 *
 * WHY separate entry: Edge runtimes cannot load Node APIs; provisioning uses process.env
 * and is not safe on edge. This keeps the bundle edge-compatible and avoids pulling
 * in code that would fail at runtime.
 */

export * from "./actions";
export * from "./basic-capabilities/index";
export * from "./character";
export * from "./character-utils";
export {
  CANONICAL_SECRET_KEYS,
  CHANNEL_OPTIONAL_SECRETS,
  LOCAL_MODEL_PROVIDERS,
  isSecretKeyAlias,
  getAliasesForKey,
  isCanonicalSecretKey,
  getProviderForApiKey,
  getRequiredSecretsForChannel,
  getAllSecretsForChannel,
  type CanonicalSecretKey,
} from "./constants";
export * from "./connection";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
export * from "./generated/action-docs";
export * from "./generated/spec-helpers";
export * from "./logger";
export * from "./markdown";
export * from "./memory";
export * from "./plugin";
export * from "./prompts";
export * from "./roles";
export * from "./runtime";
export * from "./schemas/index";
export { buildBaseTables, type BaseTables } from "./schemas/index";
export * from "./schemas/character";
export * from "./search";
export * from "./secrets";
export * from "./security";
export * from "./services";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/message";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/pairing-migration";
export * from "./services/plugin-hooks";
export * from "./services/tool-policy";
export * from "./services/trajectoryLogger";
export * from "./settings";
export * from "./streaming-context";
export * from "./trajectory-context";
export * from "./types";
export * from "./types/agentEvent";
export * from "./types/message-service";
export * from "./types/plugin-manifest";
export * from "./utils";
export * from "./validation";
export * from "./types/onboarding";
export * from "./services/onboarding-state";
export * from "./services/onboarding-cli";
export * from "./services/onboarding-rpc";
export * from "./providers/onboarding-progress";
export * from "./providers/skill-eligibility";
export * from "./utils/buffer";
export * from "./utils/channel-utils";
export * from "./utils/environment";
export * from "./utils/streaming";

export const isBrowser = false;
export const isNode = false;
export const isEdge = true;

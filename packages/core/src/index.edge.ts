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
export * from "./character";
export * from "./character-utils";
export * from "./connection";
export * from "./connectors";
export * from "./connectors/account-manager";
export * from "./connectors/privacy";
export {
	CANONICAL_SECRET_KEYS,
	type CanonicalSecretKey,
	CHANNEL_OPTIONAL_SECRETS,
	getAliasesForKey,
	getAllSecretsForChannel,
	getProviderForApiKey,
	getRequiredSecretsForChannel,
	isCanonicalSecretKey,
	isSecretKeyAlias,
	LOCAL_MODEL_PROVIDERS,
} from "./constants";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
export * from "./features/basic-capabilities/index";
export * from "./generated/action-docs";
export * from "./generated/spec-helpers";
export * from "./logger";
export * from "./markdown";
export * from "./memory";
export * from "./plugin";
export * from "./prompts";
export * from "./providers/onboarding-progress";
export * from "./providers/skill-eligibility";
export * from "./roles";
export * from "./runtime";
export * from "./runtime/rlm";
export * from "./runtime/system-prompt";
export * from "./schemas/character";
export * from "./schemas/index";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
export * from "./secrets";
export * from "./security";
export * from "./services";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/message";
export * from "./services/onboarding-cli";
export * from "./services/onboarding-rpc";
export * from "./services/onboarding-state";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/pairing-migration";
export * from "./services/plugin-hooks";
export * from "./services/tool-policy";
export * from "./services/trajectories";
export * from "./settings";
export * from "./streaming-context";
export * from "./trajectory-context";
export type { ConnectorAccountCapability, ConnectorAccountRef } from "./types";
export * from "./types";
export {
	ConnectorAccountHealth,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAuthMethod,
} from "./types";
export * from "./types/agentEvent";
export * from "./types/message-service";
export * from "./types/onboarding";
export * from "./types/plugin-manifest";
export type { JsonObject, JsonValue } from "./types/primitives";
export * from "./utils";
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/buffer";
export * from "./utils/channel-utils";
export * from "./utils/description-compressed-lint";
export * from "./utils/environment";
export * from "./utils/prompt-compression";
export * from "./utils/read-env";
export * from "./utils/streaming";
export * from "./validation";

export const isBrowser = false;
export const isNode = false;
export const isEdge = true;

/**
 * Edge runtime entry point for @elizaos/core (Vercel Edge, Cloudflare Workers, Deno Deploy).
 * Same API as node minus Node-only modules: character-loader, sessions, plugins discovery,
 * media, network/ssrf, services/hook, provisioning, utils/node.
 *
 * WHY separate entry: Edge runtimes cannot load Node APIs; provisioning uses process.env
 * and is not safe on edge. This keeps the bundle edge-compatible and avoids pulling
 * in code that would fail at runtime.
 */

export * from "./access-context";
export * from "./access-control/filter";
export * from "./account-pool-bridge";
export * from "./actions";
export * from "./activity-plaintext";
export * from "./capabilities";
export * from "./character";
export * from "./character-utils";
export * from "./connection";
export * from "./connectors";
export * from "./connectors/account-manager";
export * from "./connectors/oauth-role";
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
export * from "./messaging/interactions";
export * from "./plugin";
export * from "./prompts";
export * from "./providers/setup-progress";
export * from "./providers/skill-eligibility";
export * from "./roles";
export * from "./runtime";
export * from "./runtime/rlm";
export * from "./runtime/system-prompt";
export * from "./schemas/character";
export * from "./schemas/index";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
export * from "./security";
export * from "./services";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/message";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/runtime-capability-service";
export * from "./services/setup-cli";
export * from "./services/setup-rpc";
export * from "./services/setup-state";
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
export * from "./types/plugin-manifest";
export type { JsonObject, JsonValue, ProcessEnvLike } from "./types/primitives";
export * from "./types/setup";
export * from "./utils";
export {
	addHeader,
	composePromptFromState,
	parseKeyValueXml,
	parseToonKeyValue,
} from "./utils";
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/buffer";
export * from "./utils/channel-utils";
export * from "./utils/description-compressed-lint";
export * from "./utils/environment";
export * from "./utils/prompt-compression";
export * from "./utils/read-env";
export * from "./utils/resolve-setting";
export * from "./utils/streaming";
export * from "./validation";

export const isBrowser = false;
export const isNode = false;
export const isEdge = true;

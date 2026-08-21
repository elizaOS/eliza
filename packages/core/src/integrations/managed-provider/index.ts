/** Barrel for the managed-provider adapter SDK shared by integration plugins. */

export {
	isOpaqueConnectionId,
	type LocalConnectionConfig,
	type ManagedConnectionConfig,
	type ProviderConnectionConfig,
	type ResolvedLocalConnection,
	type ResolvedManagedConnection,
	type ResolvedProviderConnection,
	resolveProviderConnection,
} from "./connection";
export {
	isManagedProviderError,
	MANAGED_PROVIDER_ERROR_CODES,
	ManagedProviderError,
	type ManagedProviderErrorCode,
	toCapabilityExecutionErrorCode,
} from "./errors";
export {
	type ProviderHealthSnapshot,
	type ProviderHealthState,
	probeProviderHealth,
} from "./health";
export {
	MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES,
	MANAGED_PROVIDER_DEFAULT_TIMEOUT_MS,
	MANAGED_PROVIDER_MAX_RESPONSE_BYTES,
	MANAGED_PROVIDER_MAX_TIMEOUT_MS,
	MANAGED_PROVIDER_MIN_TIMEOUT_MS,
	ManagedProviderHttpClient,
	type ManagedProviderHttpClientOptions,
	type ProviderResponseSchema,
} from "./http-client";
export {
	type CollectProviderPagesOptions,
	collectProviderPages,
	type ProviderPage,
} from "./pagination";

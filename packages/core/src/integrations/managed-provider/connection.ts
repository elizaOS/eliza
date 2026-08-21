/**
 * Resolves a provider connection into the single validated shape the HTTP
 * client accepts. Managed mode carries only an opaque Cloud connection id plus
 * the Cloud gateway origin — provider tokens never reach the runtime. Local/BYO
 * mode carries an explicit user-supplied credential and endpoint. Resolution is
 * strict: an invalid or missing configuration throws; there is no silent
 * fallback from local mode to Cloud or the reverse.
 */

import { ManagedProviderError } from "./errors";

/** Cloud-issued opaque connection handles: `conn_` plus at least 16 id chars. */
const OPAQUE_CONNECTION_ID_PATTERN = /^conn_[A-Za-z0-9_-]{16,}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export function isOpaqueConnectionId(value: string): boolean {
	return OPAQUE_CONNECTION_ID_PATTERN.test(value);
}

/** Managed mode: Cloud custodies the provider credential behind the gateway. */
export interface ManagedConnectionConfig {
	mode: "managed";
	providerId: string;
	/** Opaque Cloud connection handle; never a provider token or account id. */
	connectionId: string;
	/** Origin of the Cloud provider gateway that fronts the upstream API. */
	gatewayBaseUrl: string;
}

/** Local/BYO mode: the user supplied the credential and endpoint explicitly. */
export interface LocalConnectionConfig {
	mode: "local";
	providerId: string;
	/**
	 * Caller-owned stable opaque handle for this exact local account. Distinct
	 * accounts for one provider must use distinct handles. It must not encode an
	 * endpoint, account name, credential, or other provider data.
	 */
	connectionId: string;
	/** Direct provider API origin. */
	baseUrl: string;
	/** User-supplied credential sent as a bearer token; may be absent for
	 * providers that authenticate another way or need none. */
	credential?: string;
}

export type ProviderConnectionConfig =
	| ManagedConnectionConfig
	| LocalConnectionConfig;

interface ResolvedProviderConnectionBase {
	readonly providerId: string;
	/** Opaque handle propagated on every request for audit correlation. */
	readonly connectionId: string;
	/** Origin every request is pinned to. */
	readonly baseOrigin: string;
}

export interface ResolvedManagedConnection
	extends ResolvedProviderConnectionBase {
	readonly mode: "managed";
	/** Provider credentials are held by Cloud and cannot enter the runtime. */
	readonly credential?: never;
}

export interface ResolvedLocalConnection
	extends ResolvedProviderConnectionBase {
	readonly mode: "local";
	/** Bearer credential for local mode, when the provider requires one. */
	readonly credential?: string;
}

export type ResolvedProviderConnection =
	| ResolvedManagedConnection
	| ResolvedLocalConnection;

function parseOrigin(raw: string, surface: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch (error) {
		throw new ManagedProviderError(`The ${surface} endpoint is invalid.`, {
			code: "INVALID_INPUT",
			cause: error,
		});
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ManagedProviderError(
			`The ${surface} endpoint cannot contain userinfo, query, or fragment data.`,
			{ code: "INVALID_INPUT" },
		);
	}
	if (url.pathname !== "/") {
		throw new ManagedProviderError(
			`The ${surface} endpoint must be an origin URL.`,
			{ code: "INVALID_INPUT" },
		);
	}
	return url;
}

/**
 * Validates one explicit connection configuration. Callers choose the mode
 * deterministically (policy/config), never by probing which one "works".
 */
export function resolveProviderConnection(
	config: ProviderConnectionConfig,
): ResolvedProviderConnection {
	if (!PROVIDER_ID_PATTERN.test(config.providerId)) {
		throw new ManagedProviderError("The provider id is invalid.", {
			code: "INVALID_INPUT",
			context: { mode: config.mode },
		});
	}
	if (config.mode === "managed") {
		if (!isOpaqueConnectionId(config.connectionId)) {
			throw new ManagedProviderError(
				"Managed connections require an opaque Cloud connection id.",
				{ code: "INVALID_INPUT", context: { providerId: config.providerId } },
			);
		}
		const origin = parseOrigin(config.gatewayBaseUrl, "managed gateway");
		return {
			mode: "managed",
			providerId: config.providerId,
			connectionId: config.connectionId,
			baseOrigin: origin.origin,
		};
	}
	if (!isOpaqueConnectionId(config.connectionId)) {
		throw new ManagedProviderError(
			"Local connections require a stable opaque connection id.",
			{ code: "INVALID_INPUT", context: { providerId: config.providerId } },
		);
	}
	const origin = parseOrigin(config.baseUrl, "local provider");
	if (config.credential !== undefined && config.credential.length === 0) {
		throw new ManagedProviderError(
			"A local provider credential cannot be empty.",
			{ code: "INVALID_INPUT", context: { providerId: config.providerId } },
		);
	}
	return {
		mode: "local",
		providerId: config.providerId,
		connectionId: config.connectionId,
		baseOrigin: origin.origin,
		credential: config.credential,
	};
}

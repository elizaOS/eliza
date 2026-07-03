/**
 * Credential proxy — vendor-neutral non-model credential brokering (#11536 E3).
 *
 * Node-only: the client uses `node:crypto` and the SSRF-guarded transport, so
 * this barrel is exported from `index.node.ts` only (never the browser bundle).
 *
 * @module features/credential-proxy
 */

export {
	assertRouteAllowed,
	buildCredentialProxyCanonicalString,
	CREDENTIAL_PROXY_HEADER_SIGNATURE,
	CREDENTIAL_PROXY_HEADER_TARGET,
	CREDENTIAL_PROXY_HEADER_TIMESTAMP,
	CREDENTIAL_PROXY_SIGNATURE_VERSION,
	type CredentialProxyClientConfig,
	type CredentialProxyRoute,
	CredentialProxyRouteError,
	createCredentialProxyFetch,
	credentialProxyBodyHash,
	signCredentialProxyRequest,
} from "./client.ts";
export {
	CREDENTIAL_PROXY_RAW_PAT_VARS,
	CREDENTIAL_PROXY_ROUTES_KEY,
	CREDENTIAL_PROXY_SIGNING_KEY_KEY,
	CREDENTIAL_PROXY_STRICT_KEY,
	CREDENTIAL_PROXY_TOKEN_KEY,
	CREDENTIAL_PROXY_URL_KEY,
	type CredentialProxyConfig,
	type CredentialProxyRawPatVar,
	CredentialProxyStrictError,
	DEFAULT_CREDENTIAL_PROXY_ROUTES,
	resolveCredentialProxyConfig,
} from "./config.ts";

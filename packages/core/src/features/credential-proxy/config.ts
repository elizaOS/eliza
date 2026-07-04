/**
 * Vendor-neutral credential-proxy configuration (issue #11536, phase E3).
 *
 * The credential proxy is the NON-MODEL sibling of the model gateway (E1/E2):
 * where the model gateway fronts OpenAI-compatible traffic so raw provider
 * keys never reach the model client, the credential proxy fronts arbitrary
 * third-party APIs (github first) so a raw credential — a GitHub PAT — never
 * reaches the runtime or a spawned coding sub-agent. The agent talks to the
 * proxy with a scoped handle; the proxy injects the real credential outbound
 * (header-only) and forwards to the target. This mirrors the semantics of a
 * `@stwd/proxy-client` deployment but is deliberately vendor-neutral: any
 * broker that speaks the request shape in `client.ts` works.
 *
 * Env-var names mirror the E1/E2 `ELIZA_MODEL_GATEWAY_*` convention exactly:
 *   - `ELIZA_CREDENTIAL_PROXY_URL`         proxy base URL (may be a private
 *                                          sidecar; it is trusted operator
 *                                          config, unlike the target host).
 *   - `ELIZA_CREDENTIAL_PROXY_TOKEN`       agent-scoped bearer handle. NOT the
 *                                          raw credential.
 *   - `ELIZA_CREDENTIAL_PROXY_SIGNING_KEY` optional HMAC signing key. When set,
 *                                          every proxied request is signed
 *                                          (mirrors the broker's HMAC gate).
 *   - `ELIZA_CREDENTIAL_PROXY_STRICT`      fail-closed: refuse to proceed when a
 *                                          raw PAT is present in proxy mode.
 *   - `ELIZA_CREDENTIAL_PROXY_ROUTES`      optional JSON override of the
 *                                          per-host allowlist.
 *
 * @module features/credential-proxy/config
 */

import { isTruthyEnvValue } from "../../env-utils.ts";
import type { CredentialProxyRoute } from "./client.ts";

export const CREDENTIAL_PROXY_URL_KEY = "ELIZA_CREDENTIAL_PROXY_URL";
export const CREDENTIAL_PROXY_TOKEN_KEY = "ELIZA_CREDENTIAL_PROXY_TOKEN";
export const CREDENTIAL_PROXY_SIGNING_KEY_KEY =
	"ELIZA_CREDENTIAL_PROXY_SIGNING_KEY";
export const CREDENTIAL_PROXY_STRICT_KEY = "ELIZA_CREDENTIAL_PROXY_STRICT";
export const CREDENTIAL_PROXY_ROUTES_KEY = "ELIZA_CREDENTIAL_PROXY_ROUTES";

/**
 * Raw VCS credential env vars that must never coexist with proxy mode in a
 * runtime or a spawned sub-agent. In strict mode their presence fails closed;
 * otherwise they are deleted before the proxy handle is injected. Scoped to
 * the git-over-https / GitHub-API credentials E3 brokers — the container
 * registry push credential (`GHCR_TOKEN`) is a distinct docker-login flow and
 * is out of scope here.
 */
export const CREDENTIAL_PROXY_RAW_PAT_VARS = [
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_PAT",
] as const;

export type CredentialProxyRawPatVar =
	(typeof CREDENTIAL_PROXY_RAW_PAT_VARS)[number];

/**
 * Default per-host allowlist: git-over-https and the GitHub REST API. Narrow
 * by method — git smart-HTTP only uses GET (`/info/refs`) and POST
 * (`git-receive-pack` / `git-upload-pack`); the API path adds the mutating
 * verbs. Override wholesale with `ELIZA_CREDENTIAL_PROXY_ROUTES`.
 */
export const DEFAULT_CREDENTIAL_PROXY_ROUTES: readonly CredentialProxyRoute[] =
	[
		{ host: "github.com", methods: ["GET", "POST"], pathPrefix: "/" },
		{
			host: "api.github.com",
			methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
			pathPrefix: "/",
		},
	] as const;

export interface CredentialProxyConfig {
	url: string;
	token: string;
	signingKey?: string;
	strict: boolean;
	routes: readonly CredentialProxyRoute[];
}

/**
 * Minimal accessor shape. Callers pass their existing setting resolver so
 * proxy config honours the same precedence (config-env section over
 * `process.env`) as every other orchestrator setting. Not re-exported from the
 * feature barrel — the identical `GetSettingFn` from `model-gateway.ts` owns
 * that name in the core surface.
 */
type GetSettingFn = (key: string) => string | undefined;

const trimToUndefined = (value: string | undefined): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Thrown when strict proxy mode detects a raw PAT that would bypass the
 * broker. Named so callers (e.g. the orchestrator spawn path) can refuse the
 * spawn and surface the offending variable.
 */
export class CredentialProxyStrictError extends Error {
	readonly offendingVar: string;
	constructor(offendingVar: string) {
		super(
			`Credential-proxy strict mode is on but a raw VCS credential is present: ${offendingVar}. ` +
				`Remove it so the credential proxy is the only credential path, or unset ${CREDENTIAL_PROXY_STRICT_KEY}.`,
		);
		this.name = "CredentialProxyStrictError";
		this.offendingVar = offendingVar;
	}
}

function parseRoutes(raw: string | undefined): readonly CredentialProxyRoute[] {
	const value = trimToUndefined(raw);
	if (!value) return DEFAULT_CREDENTIAL_PROXY_ROUTES;
	// A malformed routes override must fail closed (no routes = every request
	// rejected) rather than silently widening to the permissive default.
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error(
			`${CREDENTIAL_PROXY_ROUTES_KEY} must be a JSON array of { host, methods, pathPrefix }`,
		);
	}
	return parsed.map((entry, index): CredentialProxyRoute => {
		const record = entry as Record<string, unknown>;
		const host = trimToUndefined(record.host as string | undefined);
		const pathPrefix = trimToUndefined(record.pathPrefix as string | undefined);
		const methods = record.methods;
		if (!host) {
			throw new Error(
				`${CREDENTIAL_PROXY_ROUTES_KEY}[${index}] is missing a host`,
			);
		}
		if (!pathPrefix?.startsWith("/")) {
			throw new Error(
				`${CREDENTIAL_PROXY_ROUTES_KEY}[${index}] pathPrefix must start with "/"`,
			);
		}
		if (
			!Array.isArray(methods) ||
			methods.length === 0 ||
			!methods.every((m): m is string => typeof m === "string" && m.length > 0)
		) {
			throw new Error(
				`${CREDENTIAL_PROXY_ROUTES_KEY}[${index}] methods must be a non-empty string array`,
			);
		}
		return {
			host: host.toLowerCase(),
			methods: methods.map((m) => m.toUpperCase()),
			pathPrefix,
		};
	});
}

/**
 * Resolve the active credential-proxy config, or `undefined` when proxy mode
 * is off (either the URL or token is unset). Mode is ON only when BOTH the URL
 * and token are present and non-empty — mirroring the model-gateway
 * both-or-nothing rule so a half-configured proxy never silently no-ops.
 */
export function resolveCredentialProxyConfig(
	getSetting: GetSettingFn,
): CredentialProxyConfig | undefined {
	const url = trimToUndefined(getSetting(CREDENTIAL_PROXY_URL_KEY));
	const token = trimToUndefined(getSetting(CREDENTIAL_PROXY_TOKEN_KEY));
	if (!url || !token) return undefined;
	return {
		url,
		token,
		signingKey: trimToUndefined(getSetting(CREDENTIAL_PROXY_SIGNING_KEY_KEY)),
		strict: isTruthyEnvValue(getSetting(CREDENTIAL_PROXY_STRICT_KEY)),
		routes: parseRoutes(getSetting(CREDENTIAL_PROXY_ROUTES_KEY)),
	};
}

/**
 * Vendor-neutral secrets-broker configuration (issue #11536, phase E4).
 *
 * E4 gives the secrets feature a pluggable EXTERNAL-BROKER backend. The local
 * AES-GCM stores (memory/character/world/component) remain the DEFAULT; the
 * broker backend is an OPT-IN option for "eliza enterprise" deployments where
 * the operator must prove the runtime CANNOT exfiltrate tenant credentials
 * because it never holds the plaintext.
 *
 * Config names mirror the E1/E2 `ELIZA_MODEL_GATEWAY_*` and E3
 * `ELIZA_CREDENTIAL_PROXY_*` conventions exactly, keeping the whole federation
 * surface greppable and vendor-neutral. Steward is the REFERENCE broker, never
 * a branded import or hard dependency:
 *   - `ELIZA_SECRETS_BROKER_URL`     broker base URL (trusted operator config).
 *   - `ELIZA_SECRETS_BROKER_TOKEN`   agent-scoped bearer handle. NOT a secret.
 *   - `ELIZA_SECRETS_BROKER_STRICT`  fail-closed: when the broker is configured
 *                                    but unreachable, refuse rather than fall
 *                                    back to a local store that could hold
 *                                    plaintext.
 *
 * Mode is ON only when BOTH url and token are present and non-empty \u2014 the same
 * both-or-nothing rule the model gateway and credential proxy use, so a
 * half-configured broker never silently no-ops into local plaintext storage.
 *
 * @module features/secrets/storage/broker-config
 */

import { isTruthyEnvValue } from "../../../env-utils.ts";

export const SECRETS_BROKER_URL_KEY = "ELIZA_SECRETS_BROKER_URL";
export const SECRETS_BROKER_TOKEN_KEY = "ELIZA_SECRETS_BROKER_TOKEN";
export const SECRETS_BROKER_STRICT_KEY = "ELIZA_SECRETS_BROKER_STRICT";

/**
 * Resolved secrets-broker configuration. Presence of this object (returned by
 * {@link resolveSecretsBrokerConfig}) is what flips the secrets service into
 * broker-backend mode.
 */
export interface SecretsBrokerConfig {
	url: string;
	token: string;
	/**
	 * Fail-closed. When `true` and the broker is configured-but-unreachable, the
	 * store refuses (throws) instead of degrading to a local store. When
	 * `false`, an unreachable broker is a soft failure (read returns `null`),
	 * but the default LOCAL stores are still what serves keys the broker doesn't
	 * cover \u2014 the broker never silently leaks plaintext either way.
	 */
	strict: boolean;
}

/**
 * Accessor shape. Callers pass their existing setting resolver so broker config
 * honours the same precedence (config-env section over `process.env`) as every
 * other setting. Kept local (not re-exported) so it can't collide with the
 * identically-named resolver in the model-gateway / credential-proxy modules.
 */
type GetSettingFn = (key: string) => string | undefined;

const trimToUndefined = (value: string | undefined): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Thrown when strict broker mode is on and the configured broker cannot be
 * reached / refuses. Named so the service can surface a fail-closed error
 * instead of silently degrading to a local (plaintext-capable) store.
 */
export class SecretsBrokerUnavailableError extends Error {
	readonly brokerUrl: string;
	constructor(brokerUrl: string, cause?: unknown) {
		super(
			`Secrets broker is configured (${SECRETS_BROKER_URL_KEY}=${brokerUrl}) with ` +
				`${SECRETS_BROKER_STRICT_KEY} on, but the broker is unreachable. ` +
				`Refusing to fall back to local storage (fail-closed). ` +
				`Fix the broker or unset ${SECRETS_BROKER_STRICT_KEY}.`,
		);
		this.name = "SecretsBrokerUnavailableError";
		this.brokerUrl = brokerUrl;
		if (cause !== undefined) {
			(this as { cause?: unknown }).cause = cause;
		}
	}
}

/**
 * Resolve the active secrets-broker config, or `undefined` when broker mode is
 * off (either the URL or the token is unset). This is the single seam that
 * decides local-default vs broker-backend; when it returns `undefined` the
 * secrets service keeps today's behaviour byte-for-byte.
 */
export function resolveSecretsBrokerConfig(
	getSetting: GetSettingFn,
): SecretsBrokerConfig | undefined {
	const url = trimToUndefined(getSetting(SECRETS_BROKER_URL_KEY));
	const token = trimToUndefined(getSetting(SECRETS_BROKER_TOKEN_KEY));
	if (!url || !token) return undefined;
	return {
		url,
		token,
		strict: isTruthyEnvValue(getSetting(SECRETS_BROKER_STRICT_KEY)),
	};
}

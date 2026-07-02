/**
 * Vendor-neutral model-gateway resolution (issue #11536, phase E1).
 *
 * A credential broker can front all OpenAI-compatible model traffic behind a
 * single gateway so that raw provider keys never reach the model client. When
 * `ELIZA_MODEL_GATEWAY_URL` is set it takes precedence as the effective base
 * URL for every consumer that currently reads `OPENAI_BASE_URL`, and
 * `ELIZA_MODEL_GATEWAY_TOKEN` becomes the effective api key in place of
 * `OPENAI_API_KEY`. This is deliberately vendor-neutral: the gateway only has
 * to be OpenAI-compatible, it is NOT bound to any specific broker.
 *
 * Two behaviours matter for security:
 *
 * 1. When gateway mode is on, raw provider keys are SCRUBBED from the resolved
 *    OpenAI-compatible client config rather than carried alongside the gateway
 *    token. A gateway that receives a request should never also be handed the
 *    upstream key.
 * 2. In strict mode (`ELIZA_MODEL_GATEWAY_STRICT` truthy) the presence of any
 *    raw provider key is treated as a misconfiguration and we FAIL CLOSED with
 *    an error naming the offending variable. This prevents an operator from
 *    silently bypassing the broker by leaving a raw key in the environment.
 *
 * Pure string logic with no Node-only dependencies, so it is safe in the
 * browser bundle and exported from both the node and browser barrels.
 *
 * SIBLING LAYER (#11536 E2): plugins/plugin-agent-orchestrator/src/services/
 * model-gateway.ts (PR #11651, merged) covers the SPAWNED SUB-AGENT env path
 * (rewrites a child process env so Codex/Claude-Code point at the gateway).
 * This module is the CORE-RUNTIME resolution layer (documents config, llm.ts,
 * inference-provider) and is intentionally independent: packages/core must not
 * depend on a plugin, so the two shared env-var-name constants are DUPLICATED
 * here on purpose rather than imported. The env var NAMES are the canonical
 * contract shared across both layers and MUST stay identical.
 */

import { isTruthyEnvValue } from "./env-utils.ts";

/**
 * Vendor-neutral gateway env var: the OpenAI-compatible base URL that fronts
 * all model traffic when broker/gateway mode is enabled.
 *
 * Canonical name mirrors `MODEL_GATEWAY_URL_KEY` in the sibling E2 module
 * (plugins/plugin-agent-orchestrator, #11651) for cross-layer greppability.
 * Duplicated (not imported) to keep the packages/core -> plugin dependency
 * direction clean.
 */
export const MODEL_GATEWAY_URL_KEY = "ELIZA_MODEL_GATEWAY_URL";

/**
 * Vendor-neutral gateway env var: the agent-scoped bearer token the gateway
 * expects. An unmodified OpenAI SDK sends this as the api key.
 *
 * Canonical name mirrors `MODEL_GATEWAY_TOKEN_KEY` in the sibling E2 module.
 */
export const MODEL_GATEWAY_TOKEN_KEY = "ELIZA_MODEL_GATEWAY_TOKEN";

/**
 * Fail-closed strict-mode env var (E1-only; the E2 sub-agent module has no
 * strict mode). When truthy, refuse to run if a raw provider key is present
 * while gateway mode is on.
 */
export const MODEL_GATEWAY_STRICT_KEY = "ELIZA_MODEL_GATEWAY_STRICT";

/**
 * Backwards-compatible aliases (kept so existing importers/tests keep working).
 * Prefer the `*_KEY` names above, which mirror the sibling E2 module (#11651).
 */
export const ELIZA_MODEL_GATEWAY_URL = MODEL_GATEWAY_URL_KEY;
export const ELIZA_MODEL_GATEWAY_TOKEN = MODEL_GATEWAY_TOKEN_KEY;
export const ELIZA_MODEL_GATEWAY_STRICT = MODEL_GATEWAY_STRICT_KEY;

/**
 * Raw provider keys that must never coexist with the gateway token when
 * strict mode is on, and that are scrubbed from OpenAI-compatible client
 * config when gateway mode is on. Kept small and explicit on purpose.
 *
 * This is the CORE-RUNTIME subset relevant to the OpenAI-compatible client
 * paths here. The sibling E2 module maintains a broader
 * `MODEL_GATEWAY_EXCLUDED_PROVIDER_KEYS` list (#11651) because a spawned
 * sub-agent env can carry additional credential sources (CODEX_API_KEY,
 * CLAUDE_CODE_OAUTH_TOKEN, ELIZA_-prefixed keys, etc.) that don't apply to the
 * in-process model client resolved here.
 */
export const RAW_PROVIDER_KEY_VARS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
] as const;

export type RawProviderKeyVar = (typeof RAW_PROVIDER_KEY_VARS)[number];

/**
 * Minimal accessor shape. Callers pass their existing setting resolver (which
 * may layer runtime settings over `process.env`) so gateway resolution honours
 * the exact same precedence as the raw vars it replaces.
 */
export type GetSettingFn = (key: string) => string | undefined;

export interface ModelGatewayResolution {
	/** Whether gateway mode is active (i.e. a gateway URL was provided). */
	enabled: boolean;
	/** Whether strict fail-closed mode is enabled. */
	strict: boolean;
	/** Effective base URL for OpenAI-compatible clients (undefined = unchanged). */
	baseURL: string | undefined;
	/** Effective api key for OpenAI-compatible clients (undefined = unchanged). */
	apiKey: string | undefined;
}

const trimToUndefined = (value: string | undefined): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Error thrown when strict gateway mode detects a raw provider key that would
 * bypass the broker. Named so callers can distinguish it from generic config
 * errors if they want to.
 */
export class ModelGatewayStrictError extends Error {
	readonly offendingVars: RawProviderKeyVar[];

	constructor(offendingVars: RawProviderKeyVar[]) {
		super(
			`Model gateway strict mode is enabled (${ELIZA_MODEL_GATEWAY_STRICT}) ` +
				`but raw provider key(s) are set: ${offendingVars.join(", ")}. ` +
				`Remove them so all model traffic flows through the gateway ` +
				`(${ELIZA_MODEL_GATEWAY_URL}/${ELIZA_MODEL_GATEWAY_TOKEN}), ` +
				`or disable strict mode.`,
		);
		this.name = "ModelGatewayStrictError";
		this.offendingVars = offendingVars;
	}
}

/**
 * Resolve model-gateway settings from a getSetting accessor.
 *
 * @throws ModelGatewayStrictError when strict mode is on, gateway mode is on,
 *   and one or more raw provider keys are present.
 */
export function resolveModelGateway(
	getSetting: GetSettingFn,
): ModelGatewayResolution {
	const gatewayURL = trimToUndefined(getSetting(ELIZA_MODEL_GATEWAY_URL));
	const gatewayToken = trimToUndefined(getSetting(ELIZA_MODEL_GATEWAY_TOKEN));
	const strict = isTruthyEnvValue(getSetting(ELIZA_MODEL_GATEWAY_STRICT));
	const enabled = gatewayURL !== undefined;

	if (!enabled) {
		return {
			enabled: false,
			strict,
			baseURL: undefined,
			apiKey: undefined,
		};
	}

	if (strict) {
		const offendingVars = RAW_PROVIDER_KEY_VARS.filter(
			(key) => trimToUndefined(getSetting(key)) !== undefined,
		);
		if (offendingVars.length > 0) {
			throw new ModelGatewayStrictError([...offendingVars]);
		}
	}

	return {
		enabled: true,
		strict,
		baseURL: gatewayURL,
		// When gateway mode is on, the gateway token (if any) is the effective
		// api key. Raw provider keys are intentionally NOT used here.
		apiKey: gatewayToken,
	};
}

/**
 * Shape of an OpenAI-compatible base URL + api key pair, as consumed by the
 * resolved model config.
 */
export interface OpenAiCompatibleCreds {
	baseURL: string | undefined;
	apiKey: string | undefined;
}

/**
 * Apply gateway resolution to a raw OpenAI-compatible base URL / api key pair.
 *
 * When gateway mode is on:
 *   - the gateway URL overrides the base URL,
 *   - the gateway token overrides the api key,
 *   - the incoming raw api key is scrubbed (dropped) so it never travels with
 *     the gateway request.
 *
 * When gateway mode is off, the inputs are returned unchanged.
 */
export function applyModelGateway(
	raw: OpenAiCompatibleCreds,
	resolution: ModelGatewayResolution,
): OpenAiCompatibleCreds {
	if (!resolution.enabled) {
		return { baseURL: raw.baseURL, apiKey: raw.apiKey };
	}
	return {
		baseURL: resolution.baseURL ?? raw.baseURL,
		// Scrub the raw provider key: gateway mode never carries it forward.
		apiKey: resolution.apiKey,
	};
}

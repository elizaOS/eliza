/**
 * Vendor-neutral model-gateway mode for spawned coding sub-agents (#11536 E2).
 *
 * Mode is ON only when BOTH `ELIZA_MODEL_GATEWAY_URL` and
 * `ELIZA_MODEL_GATEWAY_TOKEN` are set and non-empty (config env section or
 * process env, per config-env conventions). In gateway mode a spawned
 * sub-agent's env points `OPENAI_BASE_URL` (Codex CLI) and
 * `ANTHROPIC_BASE_URL` (Claude Code via claude-agent-acp) at the gateway,
 * with the gateway token injected as the api-key env for both paths. Raw
 * provider credentials are actively excluded — deleted before the token is
 * assigned — so a sub-agent env dump contains no raw provider credential.
 * With either var unset the child env is byte-identical to non-gateway
 * behavior.
 *
 * Per-spawn scoped leases/revocation need the credential-broker API and are
 * deliberately NOT part of this slice.
 *
 * @module services/model-gateway
 */

import { readConfigEnvKey } from "./config-env.js";

export const MODEL_GATEWAY_URL_KEY = "ELIZA_MODEL_GATEWAY_URL";
export const MODEL_GATEWAY_TOKEN_KEY = "ELIZA_MODEL_GATEWAY_TOKEN";

/**
 * Raw provider credentials that must never reach a sub-agent in gateway
 * mode, from ANY source. This is the union of every model-provider
 * credential `AcpService.buildEnv` merge paths can carry into a child env:
 * - `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `CEREBRAS_API_KEY` — on the
 *   host-env forwarding allowlist (`shouldForwardEnv`).
 * - `ELIZA_OPENCODE_API_KEY` / `ELIZA_E2E_CEREBRAS_API_KEY` — raw provider
 *   keys forwarded via the broad `ELIZA_` prefix rule.
 * - `CLAUDE_CODE_OAUTH_TOKEN` — injected by multi-account selection
 *   (`selectCodingAccount` envPatch) for linked Claude subscriptions.
 * - `CODEX_API_KEY` — resolved by task-agent framework detection and
 *   accepted via spawn customCredentials.
 * (`CODEX_HOME` stays: it is a config-directory path, not a credential
 * value, and Codex api-key mode — the gateway token — overrides any
 * subscription auth.json inside it.)
 */
export const MODEL_GATEWAY_EXCLUDED_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "CEREBRAS_API_KEY",
  "ELIZA_OPENCODE_API_KEY",
  "ELIZA_E2E_CEREBRAS_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export interface ModelGatewayConfig {
  url: string;
  token: string;
}

/** The active gateway config, or undefined when gateway mode is off. */
export function resolveModelGatewayConfig(): ModelGatewayConfig | undefined {
  const url = readConfigEnvKey(MODEL_GATEWAY_URL_KEY)?.trim();
  const token = readConfigEnvKey(MODEL_GATEWAY_TOKEN_KEY)?.trim();
  if (!url || !token) return undefined;
  return { url, token };
}

/**
 * Rewrite a fully-assembled sub-agent env for gateway mode. Must run LAST in
 * `AcpService.buildEnv` so no earlier merge step can reintroduce a raw
 * provider key: the raw keys are deleted first, then the gateway token is
 * assigned, so raw values are gone from the env — not merely shadowed.
 */
export function applyModelGatewayEnv(
  env: NodeJS.ProcessEnv,
  gateway: ModelGatewayConfig,
): void {
  for (const key of MODEL_GATEWAY_EXCLUDED_PROVIDER_KEYS) {
    delete env[key];
  }
  env.OPENAI_BASE_URL = gateway.url;
  env.ANTHROPIC_BASE_URL = gateway.url;
  env.OPENAI_API_KEY = gateway.token;
  env.ANTHROPIC_API_KEY = gateway.token;
}

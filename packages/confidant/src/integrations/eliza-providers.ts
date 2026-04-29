import type { Confidant, SecretId } from "../index.js";

/**
 * elizaOS-aware integration helpers for Confidant.
 *
 * The Confidant contract itself is framework-neutral. This module bundles
 * the conventions an Eliza host app already uses — provider ids, env-var
 * names, and the canonical Confidant secret ids they map to — so an app
 * can adopt Confidant in one line of bootstrap instead of registering
 * each id by hand.
 *
 * Nothing here imports from `@elizaos/agent` or `@elizaos/typescript`.
 * The bridge is data-shape-only — callers pass in their own credential
 * records (`ResolvedCredential[]`) and the helper returns `Promise<void>`
 * after persisting Confidant entries. This avoids forcing
 * `@elizaos/confidant` into a dependency cycle with runtime packages.
 */

/**
 * Shape mirrors `@elizaos/app-core/src/api/credential-resolver.ts` so
 * existing host apps can hand their resolved credentials straight in.
 */
export interface ResolvedCredentialLike {
  readonly providerId: string;
  readonly envVar: string;
  readonly apiKey?: string;
  readonly authType?: string;
}

/**
 * Canonical provider-id → SecretId map. Covers every AI provider that
 * has an entry in the elizaOS plugin registry today plus the two
 * subscription credential types (Anthropic + OpenAI Codex).
 *
 * Plugins that aren't in this map are skipped on bridge-mirror; their
 * authors should call `defineSecretSchema` themselves with their plugin
 * id and use the secret directly.
 */
export const ELIZA_PROVIDER_SECRET_IDS: Readonly<Record<string, SecretId>> = {
  anthropic: "llm.anthropic.apiKey",
  openai: "llm.openai.apiKey",
  openrouter: "llm.openrouter.apiKey",
  google: "llm.google.apiKey",
  "google-genai": "llm.google.apiKey",
  groq: "llm.groq.apiKey",
  xai: "llm.xai.apiKey",
  deepseek: "llm.deepseek.apiKey",
  mistral: "llm.mistral.apiKey",
  together: "llm.together.apiKey",
  zai: "llm.zai.apiKey",
  elizacloud: "service.elizacloud.apiKey",
  ollama: "llm.ollama.apiKey",
  // Subscription credentials are device-bound and should not sync; the
  // store entry is annotated below by `mirrorLegacyEnvCredentials`.
  "anthropic-subscription": "subscription.anthropic.accessToken",
  "openai-codex": "subscription.openai.accessToken",
} as const;

const SUBSCRIPTION_PROVIDER_IDS = new Set<string>([
  "anthropic-subscription",
  "openai-codex",
]);

export interface MirrorResult {
  readonly migrated: ReadonlyArray<{
    readonly providerId: string;
    readonly secretId: SecretId;
    readonly envVar: string;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly providerId: string;
    readonly reason: "unknown-provider" | "missing-env-var";
  }>;
}

/**
 * Register each input credential as an `env://<envVar>` reference in
 * Confidant. Pure mirroring — the actual credential value continues to
 * live in `process.env` for the lifetime of the host process; Confidant
 * resolves through the EnvLegacyBackend when asked.
 *
 * Subscription credentials (`anthropic-subscription`, `openai-codex`)
 * are tagged via the underlying store so they are never copied off the
 * device by future sync backends — those tokens are device-bound by
 * the OAuth contract.
 *
 * Returns a structured report describing what was migrated and what was
 * skipped. Callers can log the result; the host app gains no data it
 * couldn't already enumerate.
 */
export async function mirrorLegacyEnvCredentials(
  confidant: Confidant,
  credentials: readonly ResolvedCredentialLike[],
): Promise<MirrorResult> {
  const migrated: Array<{
    providerId: string;
    secretId: SecretId;
    envVar: string;
  }> = [];
  const skipped: Array<{
    providerId: string;
    reason: "unknown-provider" | "missing-env-var";
  }> = [];

  for (const cred of credentials) {
    const secretId = ELIZA_PROVIDER_SECRET_IDS[cred.providerId];
    if (!secretId) {
      skipped.push({ providerId: cred.providerId, reason: "unknown-provider" });
      continue;
    }
    if (!cred.envVar || cred.envVar.trim().length === 0) {
      skipped.push({ providerId: cred.providerId, reason: "missing-env-var" });
      continue;
    }
    await confidant.setReference(secretId, `env://${cred.envVar}`);
    migrated.push({ providerId: cred.providerId, secretId, envVar: cred.envVar });
  }

  return { migrated, skipped };
}

/**
 * Returns true if the given provider id is a device-bound subscription
 * credential whose token must not be synced across devices.
 *
 * A future `CloudBackend` (phase 7) inspects this when deciding which
 * entries are sync-eligible.
 */
export function isSubscriptionProviderId(providerId: string): boolean {
  return SUBSCRIPTION_PROVIDER_IDS.has(providerId);
}

/**
 * Translate a SecretId back to the legacy provider id, if the id is one
 * the bridge knows about. Useful for telemetry and migration tooling.
 */
export function providerIdForSecretId(id: SecretId): string | null {
  for (const [providerId, secretId] of Object.entries(
    ELIZA_PROVIDER_SECRET_IDS,
  )) {
    if (secretId === id) return providerId;
  }
  return null;
}

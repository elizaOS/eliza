import type { Confidant, SecretId } from "../index.js";

/**
 * elizaOS-aware integration helpers for Confidant.
 *
 * The Confidant contract itself is framework-neutral. This module bundles
 * the conventions an Eliza host app already uses — env-var names and the
 * canonical Confidant secret ids they map to — so an app can adopt
 * Confidant in one line of bootstrap instead of registering each id by
 * hand.
 *
 * The map below is comprehensive across the elizaOS plugin catalog: LLM
 * providers, TTS / voice, messaging connectors, search / browser tools,
 * cloud storage, wallets, blockchain RPC providers, trading APIs, music
 * services, and miscellaneous service tokens. Plugins outside this map
 * (third-party or unreleased) self-register via `defineSecretSchema` —
 * the map is the FIRST-PARTY convention layer, not an authoritative
 * gatekeeper.
 *
 * Nothing here imports from `@elizaos/agent` or `@elizaos/typescript`.
 * The bridge is data-shape-only: callers pass in their own credential
 * records (`ResolvedCredentialLike`) and the helper persists Confidant
 * entries. This keeps `@elizaos/confidant` consumable by any host app,
 * not just the elizaOS reference runtime.
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
 * Canonical env-var-name → SecretId map for the full elizaOS ecosystem.
 *
 * Indexing by env-var name (rather than provider id) is intentional:
 * - The credential-resolver works in terms of env-var names.
 * - Some providers expose multiple env vars (Google has GOOGLE_API_KEY
 *   and GOOGLE_GENERATIVE_AI_API_KEY; Vercel has AIGATEWAY_API_KEY and
 *   AI_GATEWAY_API_KEY as aliases). Indexing by env var captures every
 *   slot directly.
 *
 * Identifier domains in use:
 *   - llm.{provider}.*           — text/image/embedding model providers
 *   - subscription.{provider}.*  — device-bound OAuth tokens
 *   - tts.{provider}.*           — text-to-speech APIs
 *   - connector.{platform}.*     — messaging / collab / dev platforms
 *   - tool.{vendor}.*            — non-platform third-party tools
 *   - storage.{vendor}.*         — object storage
 *   - wallet.*                   — local wallet material
 *   - rpc.{vendor}.*             — blockchain / on-chain data RPC
 *   - trading.{venue}.*          — trading-venue API credentials
 *   - music.{service}.*          — music metadata / catalog APIs
 *   - service.{name}.*           — first-party services (eliza cloud,
 *                                  ACP, etc.) and other service tokens
 */
export const ELIZA_ENV_TO_SECRET_ID: Readonly<Record<string, SecretId>> = {
  // ── LLM providers ──────────────────────────────────────────────────
  ANTHROPIC_API_KEY: "llm.anthropic.apiKey",
  OPENAI_API_KEY: "llm.openai.apiKey",
  OPENAI_EMBEDDING_API_KEY: "llm.openai.embeddingApiKey",
  OPENROUTER_API_KEY: "llm.openrouter.apiKey",
  GOOGLE_GENERATIVE_AI_API_KEY: "llm.google.apiKey",
  GOOGLE_API_KEY: "llm.google.apiKey",
  GROQ_API_KEY: "llm.groq.apiKey",
  XAI_API_KEY: "llm.xai.apiKey",
  DEEPSEEK_API_KEY: "llm.deepseek.apiKey",
  MISTRAL_API_KEY: "llm.mistral.apiKey",
  TOGETHER_API_KEY: "llm.together.apiKey",
  ZAI_API_KEY: "llm.zai.apiKey",

  // ── AI gateways ────────────────────────────────────────────────────
  AIGATEWAY_API_KEY: "llm.vercelAiGateway.apiKey",
  AI_GATEWAY_API_KEY: "llm.vercelAiGateway.apiKey",
  VERCEL_OIDC_TOKEN: "llm.vercelAiGateway.oidcToken",

  // ── Eliza Cloud (first-party managed backend) ──────────────────────
  ELIZAOS_CLOUD_API_KEY: "service.elizacloud.apiKey",
  ELIZAOS_CLOUD_EMBEDDING_API_KEY: "service.elizacloud.embeddingApiKey",

  // ── TTS / voice ────────────────────────────────────────────────────
  ELEVENLABS_API_KEY: "tts.elevenlabs.apiKey",

  // ── Connectors: developer platforms ────────────────────────────────
  GITHUB_API_TOKEN: "connector.github.apiToken",
  GITHUB_WEBHOOK_SECRET: "connector.github.webhookSecret",
  GITHUB_APP_PRIVATE_KEY: "connector.github.appPrivateKey",
  LINEAR_API_KEY: "connector.linear.apiKey",

  // ── Connectors: messaging ──────────────────────────────────────────
  TWILIO_AUTH_TOKEN: "connector.twilio.authToken",
  TWILIO_ACCOUNT_SID: "connector.twilio.accountSid",

  // ── Connectors: gaming platforms ───────────────────────────────────
  ROBLOX_API_KEY: "connector.roblox.apiKey",
  ROBLOX_WEBHOOK_SECRET: "connector.roblox.webhookSecret",

  // ── Connectors: X / Twitter (NOT to be confused with the LLM xai) ──
  X_API_KEY: "connector.x.apiKey",
  X_API_SECRET: "connector.x.apiSecret",
  X_ACCESS_TOKEN: "connector.x.accessToken",
  X_BEARER_TOKEN: "connector.x.bearerToken",
  X_ACCESS_TOKEN_SECRET: "connector.x.accessTokenSecret",

  // ── Workflow automation ────────────────────────────────────────────
  N8N_API_KEY: "tool.n8n.apiKey",

  // ── Browser / scraping tools ───────────────────────────────────────
  CAPSOLVER_API_KEY: "tool.capsolver.apiKey",
  BROWSERBASE_API_KEY: "tool.browserbase.apiKey",

  // ── Object storage ─────────────────────────────────────────────────
  AWS_ACCESS_KEY_ID: "storage.s3.accessKeyId",
  AWS_SECRET_ACCESS_KEY: "storage.s3.secretAccessKey",

  // ── Wallets (chain-agnostic; `default` subject for the unscoped slot)
  WALLET_SECRET_SALT: "wallet.default.secretSalt",
  WALLET_SECRET_KEY: "wallet.default.secretKey",
  WALLET_PRIVATE_KEY: "wallet.default.privateKey",

  // ── Wallets (per-chain) ────────────────────────────────────────────
  EVM_PRIVATE_KEY: "wallet.evm.privateKey",
  SOLANA_PRIVATE_KEY: "wallet.solana.privateKey",
  HEDERA_PRIVATE_KEY: "wallet.hedera.privateKey",
  POLYMARKET_PRIVATE_KEY: "wallet.polymarket.privateKey",

  // ── Blockchain RPC providers ───────────────────────────────────────
  ALCHEMY_API_KEY: "rpc.alchemy.apiKey",
  INFURA_API_KEY: "rpc.infura.apiKey",
  ANKR_API_KEY: "rpc.ankr.apiKey",
  HELIUS_API_KEY: "rpc.helius.apiKey",

  // ── On-chain data / DEX aggregators ────────────────────────────────
  BIRDEYE_API_KEY: "rpc.birdeye.apiKey",
  JUPITER_API_KEY: "rpc.jupiter.apiKey",
  MORALIS_API_KEY: "rpc.moralis.apiKey",
  COINGECKO_API_KEY: "rpc.coingecko.apiKey",
  DEXSCREENER_API_KEY: "rpc.dexscreener.apiKey",
  ZEROEX_API_KEY: "rpc.zeroex.apiKey",

  // ── Trading venues ─────────────────────────────────────────────────
  CLOB_API_KEY: "trading.polymarket.clobApiKey",
  CLOB_API_SECRET: "trading.polymarket.clobApiSecret",
  CLOB_API_PASSPHRASE: "trading.polymarket.clobApiPassphrase",

  // ── Music metadata / catalog ───────────────────────────────────────
  LASTFM_API_KEY: "music.lastfm.apiKey",
  GENIUS_API_KEY: "music.genius.apiKey",
  THEAUDIODB_API_KEY: "music.theaudiodb.apiKey",
  SPOTIFY_CLIENT_SECRET: "music.spotify.clientSecret",

  // ── Misc services ──────────────────────────────────────────────────
  ACP_GATEWAY_TOKEN: "service.acp.gatewayToken",
  ACP_GATEWAY_PASSWORD: "service.acp.gatewayPassword",
  BLOOIO_API_KEY: "service.blooio.apiKey",
  BLOOIO_WEBHOOK_SECRET: "service.blooio.webhookSecret",
  MOLTBOOK_TOKEN: "service.moltbook.token",
} as const;

/**
 * Provider-id → SecretId map. Used by callers that work in terms of the
 * elizaOS catalog's `providerId` (anthropic, openrouter, etc.) rather
 * than env-var names. Most providers map 1:1 to a single SecretId; for
 * providers with multiple env vars (Google, OpenAI), this maps to the
 * primary credential.
 */
export const ELIZA_PROVIDER_TO_SECRET_ID: Readonly<Record<string, SecretId>> =
  {
    // LLM providers (primary key only)
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
    "vercel-ai-gateway": "llm.vercelAiGateway.apiKey",
    // Subscription tokens — device-bound by OAuth contract.
    "anthropic-subscription": "subscription.anthropic.accessToken",
    "openai-codex": "subscription.openai.accessToken",
  } as const;

/**
 * Provider ids whose access token is device-bound. A future CloudBackend
 * (phase 7) inspects this when deciding which entries are sync-eligible —
 * tokens flagged here MUST NOT be copied off the originating device.
 */
const DEVICE_BOUND_PROVIDERS = new Set<string>([
  "anthropic-subscription",
  "openai-codex",
]);

/**
 * SecretIds whose value should never sync across devices, even if the
 * host app opts into cloud sync. Currently subscription OAuth tokens
 * and local wallet material.
 */
const DEVICE_BOUND_SECRET_IDS = new Set<SecretId>([
  "subscription.anthropic.accessToken",
  "subscription.openai.accessToken",
  "wallet.default.secretSalt",
  "wallet.default.secretKey",
  "wallet.default.privateKey",
  "wallet.evm.privateKey",
  "wallet.solana.privateKey",
  "wallet.hedera.privateKey",
  "wallet.polymarket.privateKey",
]);

export interface MirrorResult {
  readonly migrated: ReadonlyArray<{
    readonly providerId: string;
    readonly secretId: SecretId;
    readonly envVar: string;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly providerId: string;
    readonly envVar?: string;
    readonly reason: "unknown-env-var" | "missing-env-var";
  }>;
}

/**
 * Register each input credential as an `env://<envVar>` reference in
 * Confidant. Pure mirroring — the actual credential value continues to
 * live in `process.env` for the lifetime of the host process; Confidant
 * resolves through the EnvLegacyBackend when asked.
 *
 * Indexes lookups by env-var name (`ELIZA_ENV_TO_SECRET_ID`) so every
 * env variable in the elizaOS catalog has a stable Confidant id.
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
    envVar?: string;
    reason: "unknown-env-var" | "missing-env-var";
  }> = [];

  for (const cred of credentials) {
    if (!cred.envVar || cred.envVar.trim().length === 0) {
      skipped.push({ providerId: cred.providerId, reason: "missing-env-var" });
      continue;
    }
    const secretId = ELIZA_ENV_TO_SECRET_ID[cred.envVar];
    if (!secretId) {
      skipped.push({
        providerId: cred.providerId,
        envVar: cred.envVar,
        reason: "unknown-env-var",
      });
      continue;
    }
    await confidant.setReference(secretId, `env://${cred.envVar}`);
    migrated.push({
      providerId: cred.providerId,
      secretId,
      envVar: cred.envVar,
    });
  }

  return { migrated, skipped };
}

/**
 * Returns true if the given provider id is a device-bound subscription
 * credential whose token must not be synced across devices.
 */
export function isSubscriptionProviderId(providerId: string): boolean {
  return DEVICE_BOUND_PROVIDERS.has(providerId);
}

/**
 * Returns true if the given SecretId names a credential whose value
 * MUST NOT be synced across devices. Covers subscription OAuth tokens
 * and wallet private-key material.
 */
export function isDeviceBoundSecretId(id: SecretId): boolean {
  return DEVICE_BOUND_SECRET_IDS.has(id);
}

/**
 * Translate a SecretId back to the legacy provider id, if the id is one
 * the bridge knows about. Useful for telemetry and migration tooling.
 */
export function providerIdForSecretId(id: SecretId): string | null {
  for (const [providerId, secretId] of Object.entries(
    ELIZA_PROVIDER_TO_SECRET_ID,
  )) {
    if (secretId === id) return providerId;
  }
  return null;
}

/**
 * Translate a SecretId back to its primary env-var name, if known.
 */
export function envVarForSecretId(id: SecretId): string | null {
  for (const [envVar, secretId] of Object.entries(ELIZA_ENV_TO_SECRET_ID)) {
    if (secretId === id) return envVar;
  }
  return null;
}

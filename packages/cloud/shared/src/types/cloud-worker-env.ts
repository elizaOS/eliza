/**
 * Hono + Cloudflare Workers context types for the Cloud API.
 *
 * Bindings: env vars and platform resources injected by Workers.
 * Variables: per-request values populated by middleware (e.g. resolved user).
 */

import type { Context } from "hono";
import type { KvNamespaceLike } from "../lib/cache/adapters/kv-cache-adapter";
import type { RuntimeR2Bucket } from "../lib/storage/r2-runtime-binding";

export interface Bindings {
  // ---- Database (Railway Postgres via the Hyperdrive binding in cloud, PGlite locally) ----
  DATABASE_URL: string;
  DATABASE_URL_UNPOOLED?: string;

  // ---- Cloudflare R2 ----
  /** Object storage for voice samples, avatars, and other binary blobs. */
  BLOB: RuntimeR2Bucket;

  // ---- Cloudflare KV (Worker cache backend) ----
  /**
   * The Worker's cache store. KV is the only Worker-reachable cache backend
   * (raw TCP to an external Redis is unreliable from Workers), so CacheClient
   * prefers it when bound. Read via getCloudBinding("CACHE_KV").
   */
  CACHE_KV?: KvNamespaceLike;

  // ---- Cloudflare Registrar/DNS ----
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ELIZA_CF_REGISTRAR_DEV_STUB?: string;

  // ---- ElevenLabs ----
  ELEVENLABS_API_KEY?: string;

  // ---- Free self-hosted voice (default) ----
  /**
   * Base URL of the self-hosted Kokoro TTS service (e.g. the Railway deploy).
   * When set, the cloud TTS endpoint serves Kokoro for free (no billing) as the
   * default voice; ElevenLabs remains the opt-in / custom-voice path. Unset →
   * ElevenLabs behavior is unchanged.
   */
  KOKORO_TTS_URL?: string;
  /**
   * Base URL of the self-hosted Whisper STT service (OpenAI-compatible
   * `/v1/audio/transcriptions`, e.g. the Railway deploy). When set, the cloud
   * STT endpoint serves Whisper for free; ElevenLabs STT is the fallback.
   */
  WHISPER_STT_URL?: string;

  // ---- AI providers ----
  CEREBRAS_API_KEY?: string;
  /** BYOK OpenRouter key — the backup for models we have no native key for. */
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  ATLASCLOUD_API_KEY?: string;
  ATLASCLOUD_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  /**
   * Cloud-side HuggingFace token attached by the `/api/v1/hf-proxy/*` route so
   * gated eliza-1 bundles resolve without any local HF key on the device.
   * Deploy as a `wrangler secret`; never returned to clients.
   */
  HF_TOKEN?: string;
  /**
   * Optional monthly per-organization egress cap for the HuggingFace proxy, in
   * bytes. Unset uses the route default.
   */
  HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES?: string;
  AI_GATEWAY_API_KEY?: string;
  AIGATEWAY_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  VERCEL_OIDC_TOKEN?: string;
  /**
   * Public hostname that serves the BLOB R2 bucket. Used to construct sample
   * URLs returned to clients. Defaults to "blob.elizacloud.ai" if unset.
   */
  R2_PUBLIC_HOST?: string;
  /**
   * Base domain for managed frontend hosting system hosts. When set (e.g.
   * "sites.elizacloud.ai"), a request to `<app-slug>.<suffix>` is served from
   * the app's active frontend deployment by the Worker entry (see
   * `getHostedFrontendServeRewrite` in `packages/cloud/api/src/index.ts`).
   */
  ELIZA_FRONTEND_HOST_SUFFIX?: string;
  SQL_HEAVY_PAYLOAD_STORAGE?: string;
  SQL_HEAVY_PAYLOAD_MIN_BYTES?: string;
  SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES?: string;
  LLM_TRAJECTORY_STORAGE?: string;

  // ---- Steward (auth provider) ----
  STEWARD_API_URL?: string;
  /** Server-side base URL mirror for SSR fetches that don't go through the SDK. */
  NEXT_PUBLIC_STEWARD_API_URL?: string;
  /** HS256 secret for verifying Steward session JWTs (jose). Either name works. */
  STEWARD_SESSION_SECRET?: string;
  STEWARD_JWT_SECRET?: string;
  /** Steward vault encryption master password. Required for wallet/key operations. */
  STEWARD_MASTER_PASSWORD?: string;
  /** Tenant scoping. */
  STEWARD_TENANT_ID?: string;
  NEXT_PUBLIC_STEWARD_TENANT_ID?: string;
  STEWARD_DEFAULT_TENANT_ID?: string;
  STEWARD_DEFAULT_TENANT_KEY?: string;
  /** Server-only platform / tenant API keys. */
  STEWARD_PLATFORM_KEYS?: string;
  STEWARD_TENANT_API_KEY?: string;
  STEWARD_REQUEST_SIGNING_SECRET?: string;
  STEWARD_REQUEST_SIGNING_SECRETS?: string;
  STEWARD_REQUEST_SIGNING_KEY_ID?: string;
  RPC_URL?: string;
  CHAIN_ID?: string;

  // ---- Redis (Railway TCP via REDIS_URL + in-Worker SocketRedis in cloud;
  //      Upstash REST is a legacy fallback; Wadis embedded locally) ----
  REDIS_URL?: string;
  KV_URL?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;

  // ---- Stripe ----
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Signing secret for the Stripe **Connect** webhook endpoint
   * (`/api/v1/earnings/payout/stripe-connect/webhook`). Connect endpoints have
   * their own secret, distinct from `STRIPE_WEBHOOK_SECRET` (the main billing
   * endpoint). Must be set for the Connect payout webhook to accept events —
   * the handler fail-closes (rejects) when it is absent.
   */
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  STRIPE_CURRENCY?: string;

  // ---- Crypto payments ----
  OXAPAY_WEBHOOK_IPS?: string;
  OXAPAY_MERCHANT_API_KEY?: string;

  // ---- Cron auth ----
  CRON_SECRET?: string;

  // ---- App config ----
  NEXT_PUBLIC_APP_URL?: string;
  NEXT_PUBLIC_API_URL?: string;
  AGENT_ROUTER_ORIGIN_HOST?: string;
  ELIZA_APP_WEBHOOK_GATEWAY_URL?: string;
  ELIZA_CLOUD_AGENT_BASE_DOMAIN?: string;
  WEBHOOK_GATEWAY_URL?: string;
  GATEWAY_WEBHOOK_URL?: string;
  ELIZA_APP_WEBHOOK_PROJECT?: string;
  ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL?: string;
  DISCORD_WEBHOOK_HANDLER_URL?: string;
  CONTAINER_CONTROL_PLANE_URL?: string;
  HETZNER_CONTAINER_CONTROL_PLANE_URL?: string;
  CONTAINER_CONTROL_PLANE_TOKEN?: string;
  HCLOUD_TOKEN?: string;
  CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY?: string;
  CONTAINERS_AUTOSCALE_NODE_CAPACITY?: string;
  CONTAINERS_BOOTSTRAP_CALLBACK_URL?: string;
  CONTAINERS_BOOTSTRAP_SECRET?: string;
  CONTAINERS_HCLOUD_LOCATION?: string;
  NODE_ENV?: string;

  // ---- Feature flags ----
  REDIS_RATE_LIMITING?: string;
  CACHE_ENABLED?: string;
  CACHE_BACKEND?: string;
  APPS_DEPLOY_ENABLED?: string;
  APPS_DEPLOY_ALLOWED_ORG_IDS?: string;
  // Inference hot path (#9899). The auth+moderation single-read cache is the
  // default now (no flag). INFERENCE_OPTIMISTIC_BILLING="true" enables Tier-2
  // off-path billing (requires the durable backstop). SAFE_BALANCE_THRESHOLD
  // (USD) gates the optimistic path; unset/invalid -> +Inf (every org takes the
  // safe synchronous-reserve path).
  INFERENCE_OPTIMISTIC_BILLING?: string;
  SAFE_BALANCE_THRESHOLD?: string;
  // Optimistic-billing durable backstop selector. "db" routes the pending-charge
  // + settlement through the inference_pending_charges DB ledger (atomic
  // overdraw bound + exactly-once settle + age-ordered sweep); anything else
  // (default) keeps the KV backstop. Both still require INFERENCE_OPTIMISTIC_BILLING.
  INFERENCE_BILLING_LEDGER?: string;
  RATE_LIMIT_DISABLED?: string;
  RATE_LIMIT_MULTIPLIER?: string;
  PLAYWRIGHT_TEST_AUTH?: string;
  PLAYWRIGHT_TEST_AUTH_SECRET?: string;
  TWILIO_SMS_COST_PER_SEGMENT_USD?: string;
  // #11058: reclaim TTL (ms) for the reclaim-stale-domains cron — external
  // managed-domain rows still unverified after this age are released. 48h default.
  MANAGED_DOMAIN_UNVERIFIED_TTL_MS?: string;

  // Allow overflow — handlers can read any env var via c.env.
  [key: string]: unknown;
}

/**
 * Currently-resolved user. Kept loose because the shared
 * `UserWithOrganization` type pulls in DB types we don't want to depend on
 * from every auth shim. Use `requireUser(c)` to get a typed result.
 */
export interface AuthedUser {
  id: string;
  email?: string | null;
  /** Whether `email` is verified — gates the @elizalabs.ai super_admin grant. */
  email_verified?: boolean | null;
  organization_id?: string | null;
  organization?: { id: string; name?: string; is_active?: boolean } | null;
  is_active?: boolean;
  role?: string;
  steward_id?: string | null;
  wallet_address?: string | null;
  is_anonymous?: boolean;
}

export interface Variables {
  user: AuthedUser | null | undefined;
  authMethod?: "session" | "api_key" | "wallet_signature" | "anonymous";
  requestId: string;
  /** ID of the validated API key, when `authMethod === "api_key"`. */
  apiKeyId?: string;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type AppContext = Context<AppEnv>;

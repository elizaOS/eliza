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
  // ---- Deployment environment ----
  /**
   * Wrangler environment name (`"production"` | `"staging"`); unset in local
   * dev/tests. Drives environment-scoped behavior that must not collide across
   * envs sharing the elizacloud.ai cookie zone — e.g. Steward auth cookie
   * names (`lib/auth/steward-cookies.ts`) and cache key prefixes.
   */
  ENVIRONMENT?: string;

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
   * Enables the first-line TTS cache on the free Kokoro branch (#14375). Short
   * whole-input openers ("Got it.", "Sure.") are served from the provider-keyed
   * cache instead of paying full Railway synthesis every turn. Truthy values:
   * `"1"`/`"true"`/`"yes"`. Default off — the rollout is gated on the #14370
   * TTFB benchmark (short-sentence TTFB above threshold), which needs the live
   * Railway service to measure. ElevenLabs caching is unaffected by this flag.
   */
  KOKORO_FIRST_LINE_CACHE?: string;
  /**
   * Deploy identity of the Kokoro service, folded into the cache `voiceRevision`
   * so a model/image change on the Railway side invalidates only Kokoro entries.
   * Defaults to `"unpinned"` when unset — set it to the deployed image tag/digest
   * so a redeploy that changes audio output rolls the Kokoro cache.
   */
  KOKORO_SERVICE_IMAGE_TAG?: string;
  /**
   * Base URL of the self-hosted Whisper STT service (OpenAI-compatible
   * `/v1/audio/transcriptions`, e.g. the Railway deploy). When set, the cloud
   * STT endpoint serves Whisper for free; ElevenLabs STT is the fallback.
   */
  WHISPER_STT_URL?: string;
  /**
   * Model id passed to the self-hosted Whisper STT service. Optional; defaults
   * to the multilingual `Systran/faster-whisper-small`, so the forwarded
   * `languageCode` works for the non-English persona corpus. Set this to pin a
   * different hosted model for a deployment.
   */
  WHISPER_STT_MODEL?: string;

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
  /** Public VAPID key exposed by the static manifest route and used to gate web-push enablement. */
  ELIZA_WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  /** Private VAPID key used only by the cloud sender; deploy as a Worker secret. */
  ELIZA_WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  /** VAPID contact subject sent to push services, e.g. `mailto:ops@example.com`. */
  ELIZA_WEB_PUSH_VAPID_SUBJECT?: string;
  AGENT_ROUTER_ORIGIN_HOST?: string;
  /**
   * When `"true"`/`"1"`, the agent-router reaches a running sandbox through the
   * docker host's published bridge/web ports instead of a headscale mesh IP. The
   * dedicated-agent proxy reads it to mirror that gate: with fallback off (the
   * staging default), a running sandbox that has no `headscale_ip` is unroutable,
   * so the proxy short-circuits to a readable 503 instead of a CORS-less CP 404.
   */
  AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK?: string;
  ELIZA_APP_WEBHOOK_GATEWAY_URL?: string;
  ELIZA_CLOUD_AGENT_BASE_DOMAIN?: string;
  WEBHOOK_GATEWAY_URL?: string;
  GATEWAY_WEBHOOK_URL?: string;
  ELIZA_APP_WEBHOOK_PROJECT?: string;
  // Dedicated shared secret stamped onto forwarded webhook calls so the internal
  // gateway can reject traffic that didn't transit the BFF forwarder (finding
  // L3). Deliberately separate from GATEWAY_INTERNAL_SECRET (internal-event
  // path) so enabling this gate never affects direct provider webhooks.
  ELIZA_APP_WEBHOOK_GATEWAY_SECRET?: string;
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
  /**
   * Git commit stamped at deploy time so `/api/health` can prove which Worker
   * revision is currently served before CI allows another deploy to overwrite it.
   */
  ELIZA_DEPLOY_COMMIT?: string;

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

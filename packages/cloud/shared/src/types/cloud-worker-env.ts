/**
 * Hono + Cloudflare Workers context types for the Cloud API.
 *
 * Bindings: env vars and platform resources injected by Workers.
 * Variables: per-request values populated by middleware (e.g. resolved user).
 */

import type { BrowserWorker } from "@cloudflare/playwright";
import type { Context } from "hono";
import type { KvNamespaceLike } from "../lib/cache/adapters/kv-cache-adapter";
import type { RuntimeR2Bucket } from "../lib/storage/r2-runtime-binding";

export interface RuntimeRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RuntimeDurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface RuntimeDurableObjectNamespace {
  getByName(name: string): RuntimeDurableObjectStub;
}

export interface Bindings {
  // ---- Deployment environment ----
  /**
   * Wrangler environment name (`"production"` | `"staging"`); unset in local
   * dev/tests. Drives environment-scoped behavior that must not collide across
   * envs and previews — e.g. Steward auth cookie names
   * (`lib/auth/steward-cookies.ts`) and cache key prefixes.
   */
  ENVIRONMENT?: string;
  /** Public eliza.app agent used only when its exact Twilio line is called. */
  ELIZA_APP_DEFAULT_AGENT_ID?: string;
  /** Exact E.164 Twilio number allowed to route to the public default agent. */
  ELIZA_APP_TWILIO_PHONE_NUMBER?: string;
  /** Maximum unauthenticated Twilio media sockets awaiting a signed start frame. */
  TWILIO_VOICE_MAX_PENDING_BOOTSTRAPS?: string;
  /** Milliseconds allowed for a Twilio media socket to provide its signed start frame. */
  TWILIO_VOICE_BOOTSTRAP_TIMEOUT_MS?: string;
  /** Staging-only QA session bridge kill switch; absent/anything but "true" is off. */
  STAGING_SESSION_EXCHANGE_ENABLED?: string;
  /** Exact runtime/code contract version; currently only "v1" is accepted. */
  STAGING_SESSION_EXCHANGE_VERSION?: string;
  /** Dedicated HS256 key; must differ from every ordinary Steward JWT secret. */
  STAGING_SESSION_EXCHANGE_SIGNING_SECRET?: string;
  /** Dedicated protected-header kid (`staging-qa-v1-*`). */
  STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID?: string;
  /** Exact API-key UUIDs permitted to mint a full QA browser session. */
  STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS?: string;
  /** Exact Cloud user UUIDs eligible for the staging QA session bridge. */
  STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS?: string;
  /** Exact Cloud organization UUIDs eligible for the staging QA session bridge. */
  STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS?: string;
  /**
   * Routes chat completions through the lazy chat-only Worker application.
   * Default off provides an immediate rollback to the monolithic router.
   */
  THIN_INFERENCE_ENTRY_ENABLED?: string;
  /**
   * Secondary kill switch for durable auto-top-up claims. Only the exact
   * string "true" permits new claims; recovery and signed reconciliation run
   * while it is absent or false, subject to the primary database control.
   */
  AUTO_TOP_UP_DURABLE_ENABLED?: string;
  /** Registered active and approved `apps.id` for the native Cloud client. */
  ELIZA_MOBILE_APP_AUTH_APP_ID?: string;
  /** Global mobile app-auth lifecycle kill switch; only "true" enables it. */
  ELIZA_MOBILE_APP_AUTH_ENABLED?: string;

  // ---- Database (Railway Postgres via the Hyperdrive binding in cloud, PGlite locally) ----
  DATABASE_URL: string;
  DATABASE_URL_UNPOOLED?: string;
  /**
   * Diagnostic-only override for running agent-sandbox schema convergence in
   * workerd. Canonical deploys repair the schema before Worker publication;
   * leave this unset during normal operation.
   */
  AGENT_SANDBOX_ENSURE_IN_WORKER?: string;

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

  /** Cloudflare Browser Run endpoint used by the managed DoorDash adapter. */
  BROWSER?: BrowserWorker;

  /**
   * One strongly ordered coordinator per shared agent conversation. The object
   * owns warm history and mirrors it to Postgres after the response path.
   */
  SHARED_RUNTIME_CONVERSATIONS?: RuntimeDurableObjectNamespace;

  /**
   * One strongly ordered admission coordinator per organization. It serializes
   * cached balance leases and endpoint rate limits without querying Postgres.
   */
  INFERENCE_ADMISSION_GATES?: RuntimeDurableObjectNamespace;

  /** Atomic per-user ledger preventing duplicate confirmed DoorDash checkout submissions. */
  DOORDASH_CHECKOUT_GATES?: RuntimeDurableObjectNamespace;

  /**
   * One strongly ordered identity/quota cache per anonymous chat session.
   * Postgres hydration and counter mirrors run only outside the response path.
   */
  ANONYMOUS_CHAT_GATES?: RuntimeDurableObjectNamespace;

  /** One strongly ordered transcript and replay ledger per onboarding session. */
  ONBOARDING_SESSIONS?: RuntimeDurableObjectNamespace;

  /** One strongly ordered X credential refresh coordinator per organization and role. */
  TWITTER_OAUTH_REFRESH_COORDINATORS?: RuntimeDurableObjectNamespace;

  /** One explicitly invalidated Shared account projection per connector sender. */
  PERSONAL_DELIVERY_PROJECTIONS?: RuntimeDurableObjectNamespace;
  /** Two-phase rollout gate; readers activate only after invalidation writers are the rollback baseline. */
  PERSONAL_DELIVERY_PROJECTION_READ_ENABLED?: string;
  /** Exact-once Telegram egress ledger for Personal Shared edge delivery. */
  PERSONAL_TELEGRAM_DELIVERIES?: RuntimeDurableObjectNamespace;

  // ---- Cloudflare machine-local protective rate limits ----
  GLOBAL_RATE_LIMITER?: RuntimeRateLimitBinding;
  CHAT_ROUTE_RATE_LIMITER?: RuntimeRateLimitBinding;
  DASHBOARD_CHAT_ROUTE_RATE_LIMITER?: RuntimeRateLimitBinding;
  MOBILE_API_KEY_INGRESS_LIMITER?: RuntimeRateLimitBinding;

  // ---- Cloudflare Registrar/DNS ----
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ELIZA_CF_REGISTRAR_DEV_STUB?: string;

  // ---- ElevenLabs ----
  ELEVENLABS_API_KEY?: string;

  // ---- Cartesia ----
  /**
   * Server-side Cartesia API key. When set, un-pinned/default cloud TTS
   * synthesizes with Cartesia Sonic (MP3 via the REST bytes endpoint, WAV via
   * the streaming adapter for codec-less clients). Batch STT uses Cartesia
   * only when VOICE_BATCH_STT_PROVIDER=cartesia; otherwise Whisper remains the
   * unpinned default. Unset falls back to the Kokoro/ElevenLabs TTS chain.
   */
  CARTESIA_API_KEY?: string;
  /** Overrides the default Cartesia voice id used for un-pinned requests. */
  CARTESIA_VOICE_ID?: string;
  /** Legacy name accepted while deploy environments migrate to CARTESIA_VOICE_ID. */
  CARTESIA_DEFAULT_VOICE_ID?: string;

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
   * STT endpoint serves Whisper for free whenever Cartesia does not claim the
   * batch default; ElevenLabs STT is the fallback.
   */
  WHISPER_STT_URL?: string;
  /**
   * Model id passed to the self-hosted Whisper STT service. Optional; defaults
   * to the multilingual `Systran/faster-whisper-small`, so the forwarded
   * `languageCode` works for the non-English persona corpus. Set this to pin a
   * different hosted model for a deployment.
   */
  WHISPER_STT_MODEL?: string;
  /**
   * Positive integer byte cap for the whole STT multipart request, including
   * MIME boundaries and field overhead. Unset defaults to 25 MiB; invalid
   * values fail the STT route closed instead of weakening the upload guard.
   */
  VOICE_STT_MAX_MULTIPART_BYTES?: string;

  // ---- Realtime voice-session WebSocket (Phase 1, flag-gated) ----
  /**
   * Master flag for the realtime voice-session WebSocket path
   * (VOICE-INTEGRATION-DECISION §8). Default OFF. The mint/revoke route and the
   * WS handler both consult `isVoiceRealtimeWsEnabled(env)`; when unset/false the
   * route returns 404 (feature-absent) so the client falls back to the existing
   * batch STT/TTS path. This is a REAL runtime consumer, not a dead flag.
   */
  VOICE_REALTIME_WS_ENABLED?: string;
  /** Cartesia voice id (UUID) used for the realtime downlink. */
  VOICE_REALTIME_CARTESIA_VOICE_ID?: string;
  /** Default-off flag that promotes Fish Audio to primary realtime TTS. */
  ELIZA_TTS_FISH_ENABLED?: string;
  FISH_AUDIO_DATA_GOVERNANCE_APPROVED?: string;
  /** Server-side Fish Audio API key for realtime TTS. */
  FISH_AUDIO_API_KEY?: string;
  /** Fish realtime model: s1, s2-pro, s2.1-pro, or s2.1-pro-free. */
  FISH_AUDIO_MODEL?: string;
  /** Fish reference/voice id for realtime TTS. */
  FISH_AUDIO_REFERENCE_ID?: string;
  /** Legacy alias for the Fish realtime reference id. */
  FISH_AUDIO_VOICE_ID?: string;
  /** Fish realtime output sample rate; the voice-session contract is raw PCM at 16 kHz. */
  FISH_AUDIO_SAMPLE_RATE?: string;
  /** Pre-first-audio timeout that permits Fish -> Cartesia fallback. */
  FISH_AUDIO_FIRST_AUDIO_TIMEOUT_MS?: string;
  /**
   * API origin for the LLM leg. The bridge constructs the canonical
   * `/eliza/agents/:agentId/api/conversations/:conversationId/messages/stream`
   * URL from the signed voice-session scope. Never point this at a raw model
   * gateway, which would bypass agent context and conversation persistence.
   */
  VOICE_REALTIME_ELIZA_ENDPOINT?: string;
  /**
   * Server-held credential (Bearer value) the voice-session uses to call the
   * internal canonical agent message SSE leg. The realtime WS is headerless (WebView
   * 113), so the client's Authorization is unavailable inside the session; the
   * server presents this credential instead. The user identity is carried by
   * the verified voice-token claims, NOT by the client. Deploy as a wrangler
   * secret; never returned to clients.
   */
  VOICE_REALTIME_ELIZA_AUTHORIZATION?: string;
  /** Legacy model setting retained for rollout compatibility. */
  VOICE_REALTIME_ELIZA_MODEL?: string;
  /** Per-org daily voice minute cap (SEC-15). */
  VOICE_REALTIME_ORG_DAILY_MINUTES?: string;
  /** Per-user daily voice minute cap (SEC-15). */
  VOICE_REALTIME_USER_DAILY_MINUTES?: string;
  /** Max concurrent live voice sessions per worker. */
  VOICE_REALTIME_MAX_SESSIONS?: string;

  // ---- AI providers ----
  CEREBRAS_API_KEY?: string;
  /**
   * Batch STT provider override: `deepgram` | `cartesia` | `whisper` |
   * `elevenlabs`. Unset uses Whisper when configured, otherwise ElevenLabs.
   * Paid providers are never selected by key presence alone, and an override
   * whose required binding is missing fails the route closed.
   */
  VOICE_BATCH_STT_PROVIDER?: string;
  /** Opt-in prerecorded Deepgram STT key (server-held; never returned to clients). */
  DEEPGRAM_API_KEY?: string;
  /** Effective USD price of one credit on the deployed Cartesia account. */
  CARTESIA_STT_USD_PER_CREDIT?: string;
  /** Cartesia batch STT request timeout in milliseconds (default 120000, max 300000). */
  CARTESIA_BATCH_STT_TIMEOUT_MS?: string;
  /** BYOK OpenRouter key — the backup for models we have no native key for. */
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  ATLASCLOUD_API_KEY?: string;
  ATLASCLOUD_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  /**
   * Base URL of the self-hosted TEI embeddings sidecar
   * (packages/cloud/services/embeddings). Setting it routes the local
   * `bge-small-en-v1.5` embedding id there; `/v1` suffix optional.
   */
  LOCAL_EMBEDDINGS_BASE_URL?: string;
  /** Bearer token for the sidecar, only when its TEI `API_KEY` gate is set. */
  LOCAL_EMBEDDINGS_API_KEY?: string;
  /** "true" routes EVERY embedding id to the sidecar (aliases onto the local model). */
  ELIZA_EMBEDDINGS_FORCE_LOCAL?: string;
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
  VERCEL_OIDC_TOKEN?: string;
  /**
   * Public hostname that serves the BLOB R2 bucket. Used to construct sample
   * URLs returned to clients. Defaults to "blob.eliza.app" if unset.
   */
  R2_PUBLIC_HOST?: string;
  /**
   * Comma-separated HMAC keys for opaque private-storage capabilities. The
   * first key signs and all keys verify, allowing bounded rotation overlap.
   */
  STORAGE_READ_SIGNING_SECRETS?: string;
  /**
   * Base domain for managed frontend hosting system hosts. When set (e.g.
   * "sites.eliza.app"), a request to `<app-slug>.<suffix>` is served from
   * the app's active frontend deployment by the Worker entry (see
   * `getHostedFrontendServeRewrite` in `packages/cloud/api/src/index.ts`).
   */
  ELIZA_FRONTEND_HOST_SUFFIX?: string;
  SQL_HEAVY_PAYLOAD_STORAGE?: string;
  SQL_HEAVY_PAYLOAD_MIN_BYTES?: string;
  SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES?: string;
  /**
   * Hard ceiling, in bytes, on a single field persisted inline in a SQL text or
   * jsonb column when object storage is unavailable. Defaults to 1 MiB; values
   * below 1024 are ignored.
   */
  SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES?: string;
  LLM_TRAJECTORY_STORAGE?: string;

  // ---- Steward (auth provider) ----
  STEWARD_API_URL?: string;
  /** Server-side base URL mirror for SSR fetches that don't go through the SDK. */
  NEXT_PUBLIC_STEWARD_API_URL?: string;
  /** HS256 secret for verifying Steward session JWTs (jose). Either name works. */
  STEWARD_SESSION_SECRET?: string;
  /** Optional dedicated secret for OAuth success-page HMAC proofs; falls back to STEWARD_SESSION_SECRET. */
  OAUTH_SUCCESS_PROOF_SECRET?: string;
  /** Dedicated HMAC key for short-lived remote pairing-code verifiers. */
  REMOTE_PAIRING_HMAC_SECRET?: string;
  /** Required managed Google OAuth application credentials. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  STEWARD_JWT_SECRET?: string;
  /** HS256 service-account bridge secret; must never equal the staging QA signer. */
  ELIZA_SERVICE_JWT_SECRET?: string;
  /** Optional issuer pin for service-account JWTs (jose enforces it only when set). */
  ELIZA_SERVICE_JWT_ISSUER?: string;
  /** Optional audience pin for service-account JWTs (jose enforces it only when set). */
  ELIZA_SERVICE_JWT_AUDIENCE?: string;
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

  // ---- OpenID Connect provider (Eliza Cloud as the OP for Eliza Hub) ----
  /** Kill switch. The provider serves nothing unless this is exactly "true". */
  OIDC_ENABLED?: string;
  /**
   * Issuer string, emitted VERBATIM into the discovery document and every
   * token, and the only host the OIDC endpoints answer on. Relying parties
   * byte-compare it, so a trailing slash or host change invalidates every
   * existing account link. Must be a host this Worker is routed for — the
   * public homepage is a Pages app and never reaches the Worker directly.
   */
  OIDC_ISSUER_URL?: string;
  /**
   * Secret: JSON array of PRIVATE JWKs (optionally base64-wrapped). Element 0
   * signs; every element is published at `jwks_uri`, which is what makes an
   * overlapping key rotation possible.
   */
  OIDC_SIGNING_JWKS?: string;
  /**
   * Secret: JSON array of relying-party registry entries (optionally
   * base64-wrapped). Client secrets are stored as sha256 hex only.
   */
  OIDC_CLIENTS?: string;
  /**
   * Public JSON object of client_id → additional exact HTTPS callbacks used
   * during canonical-domain migrations. The client must already exist in
   * OIDC_CLIENTS; this overlay cannot create or otherwise modify a client.
   */
  OIDC_REDIRECT_URI_ALIASES?: string;
  /**
   * Domain that wallet-derived no-reply identities are minted on, for relying
   * parties registered with `wallet_email_fallback`. Defaults to
   * `users.noreply.<OIDC_ISSUER_URL hostname>` and is normally left unset.
   *
   * An override is accepted ONLY when it is a strict subdomain of the issuer
   * hostname — that rule is what proves no user can register a name there, which
   * is the entire security property of the address. Set but invalid turns the
   * wallet-identity feature OFF with a named reason (`OidcConfig.
   * walletEmailUnavailableReason`) and leaves the rest of the provider serving;
   * it is one optional variable and must not 503 every relying party. A
   * committed var, not a secret, for the same reason as OIDC_ISSUER_URL: losing
   * it must not silently rewrite every wallet user's account identity at the
   * relying party.
   */
  OIDC_WALLET_EMAIL_DOMAIN?: string;

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
   * Test-only Stripe-compatible loopback origin. The Stripe client accepts it
   * only under the explicit CLOUD_E2E + NODE_ENV=test gates and never in prod.
   */
  STRIPE_CLOUD_E2E_API_ORIGIN?: string;
  /**
   * Signing secret for the Stripe **Connect** webhook endpoint
   * (`/api/v1/earnings/payout/stripe-connect/webhook`). Connect endpoints have
   * their own secret, distinct from `STRIPE_WEBHOOK_SECRET` (the main billing
   * endpoint). Must be set for the Connect payout webhook to accept events —
   * the handler fail-closes (rejects) when it is absent.
   */
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  STRIPE_CURRENCY?: string;
  /** Server-only recurring Plus plan Stripe Price binding. */
  STRIPE_PLUS_MONTHLY_PRICE_ID?: string;
  /** Server-only approved Stripe Product for the Plus plan. */
  STRIPE_PLUS_PRODUCT_ID?: string;
  /** Server-only recurring Pro plan Stripe Price binding. */
  STRIPE_PRO_MONTHLY_PRICE_ID?: string;
  /** Server-only approved Stripe Product for the Pro plan. */
  STRIPE_PRO_PRODUCT_ID?: string;

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
  /** APNs provider key contents; secret and never returned to clients. */
  ELIZA_APNS_KEY?: string;
  /** APNs provider key id used as the ES256 JWT kid. */
  ELIZA_APNS_KEY_ID?: string;
  /** Apple Developer team id used as the ES256 JWT issuer. */
  ELIZA_APNS_TEAM_ID?: string;
  /** Must equal the signed iOS bundle id, ai.elizaos.app. */
  ELIZA_APNS_TOPIC?: string;
  /** Explicit APNs host selection: 0 sandbox, 1 production. */
  ELIZA_APNS_PRODUCTION?: string;
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
  /**
   * Exactly `"true"` enables vision descriptions of inbound Blooio image media
   * on Personal Shared turns; any other value keeps the raw media-URL text.
   * The gateway-webhook service reads the same variable to decide whether to
   * forward media URLs at all, so enable both deployments together.
   * Keep this unset outside tests until the retention, real-PostgreSQL
   * concurrency, signed Blooio/provider, and edge-egress promotion gates in
   * `docs/inbound-media-vision-promotion.md` are complete.
   */
  ELIZA_APP_INBOUND_MEDIA_VISION?: string;
  /**
   * Per-UTC-day image ceilings for pooled-key inbound media vision, consumed
   * atomically from the primary-database ledger before any provider call: one
   * for the resolved sending account and one across every sender of a
   * connector account. Unset keeps the conservative defaults in
   * `inbound-media-enrichment.ts`; "0" denies every description; any value
   * that is not a non-negative integer fails closed (no vision, raw media
   * text kept) and is logged as a configuration error.
   */
  ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES?: string;
  ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES?: string;
  /** Moves only the official Personal Shared Telegram transport to the Worker edge. */
  PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED?: string;
  /** Collision-free secret used by the protected staging edge cutover. */
  PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED?: string;
  /** Collision-free secret used by the protected production edge cutover; inert outside production. */
  PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED?: string;
  ELIZA_APP_TELEGRAM_BOT_TOKEN?: string;
  ELIZA_APP_TELEGRAM_WEBHOOK_SECRET?: string;
  // Dedicated shared secret stamped onto forwarded webhook calls so the internal
  // gateway can reject traffic that didn't transit the BFF forwarder (finding
  // L3). Deliberately separate from GATEWAY_INTERNAL_SECRET (internal-event
  // path) so enabling this gate never affects direct provider webhooks.
  ELIZA_APP_WEBHOOK_GATEWAY_SECRET?: string;
  /** Authenticates proactive Shared reminder delivery to the Railway gateway. */
  GATEWAY_INTERNAL_SECRET?: string;
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
  /** Exact local full-stack test gate; never set on deployed Workers. */
  CLOUD_E2E?: string;
  /** Unique local-only receipt used to bind Worker E2E probes to their owner. */
  CLOUD_E2E_RUN_RECEIPT?: string;
  /**
   * Git commit stamped at deploy time so `/api/health` can prove which Worker
   * revision is currently served before CI allows another deploy to overwrite it.
   */
  ELIZA_DEPLOY_COMMIT?: string;

  // ---- Feature flags ----
  REDIS_RATE_LIMITING?: string;
  CACHE_ENABLED?: string;
  CACHE_BACKEND?: string;
  DIRECT_REDIS_BACKEND?: string;
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
  // Tier-3 deferred admission (#9899): "true" moves the durable admission WRITE
  // (ledger insert / KV pending charge) off the pre-forward critical path via
  // executionCtx.waitUntil, keeping a cached balance gate (15s org-balance hint
  // + in-isolate refusal blocklist) on-path. Requires INFERENCE_OPTIMISTIC_BILLING.
  INFERENCE_DEFERRED_ADMISSION?: string;
  // Tier-3 in-isolate decision caches (#9899): "true" enables the org
  // rate-limit lease (convergent — leased requests are carried back into the
  // Redis window), the 60s shouldBlockUser memo, and the 60s model-catalog
  // memo. Separate from INFERENCE_DEFERRED_ADMISSION (orthogonal to billing).
  INFERENCE_HOT_PATH_CACHES?: string;
  INFERENCE_AUTH_CACHE_ENABLED?: string;
  /** Strong Durable Object boundary required before positive auth caching can activate. */
  INFERENCE_STRONG_REVOCATION_ENABLED?: string;
  // Pass-through streaming fast path (#15428): "true" pipes qualifying
  // streamed chat completions (OpenAI-compatible direct upstream, no
  // tools/response_format/web-search) byte-for-byte from the provider instead
  // of decoding/re-encoding through the AI SDK; usage is metered from a teed
  // branch and billed through the existing settle chain. Default off;
  // rollback = flip off (the SDK path is untouched).
  INFERENCE_PASSTHROUGH_STREAMING?: string;
  RATE_LIMIT_DISABLED?: string;
  RATE_LIMIT_MULTIPLIER?: string;
  PLAYWRIGHT_TEST_AUTH?: string;
  PLAYWRIGHT_TEST_AUTH_SECRET?: string;
  TWILIO_SMS_COST_PER_SEGMENT_USD?: string;
  // #11058: reclaim TTL (ms) for the reclaim-stale-domains cron — external
  // managed-domain rows still unverified after this age are released. 48h default.
  MANAGED_DOMAIN_UNVERIFIED_TTL_MS?: string;
  // #16071: grace window (ms) for the gc-stranded-sandbox-keys cron — stranded
  // agent-sandbox keys older than this are revoked. 6h default; must exceed any
  // real mint-to-commit latency so an in-flight single-flight mint is untouched.
  STRANDED_SANDBOX_KEY_GRACE_MS?: string;

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
  created_at?: Date | string;
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
  /** Application-level correlation id forwarded across Worker/origin hops. */
  traceId: string;
  /** ID of the validated API key, when `authMethod === "api_key"`. */
  apiKeyId?: string;
  /** Registered app that issued a mobile lifecycle credential. */
  apiKeySourceAppId?: string;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type AppContext = Context<AppEnv>;

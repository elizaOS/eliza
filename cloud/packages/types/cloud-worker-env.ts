/**
 * Hono + Cloudflare Workers context types for the Cloud API.
 *
 * Bindings: env vars and platform resources injected by Workers.
 * Variables: per-request values populated by middleware (e.g. resolved user).
 */

import type { Context } from "hono";
import type { RuntimeR2Bucket } from "../lib/storage/r2-runtime-binding";

export interface Bindings {
  // ---- Database (Neon Postgres in cloud, PGlite locally) ----
  DATABASE_URL: string;
  DATABASE_URL_UNPOOLED?: string;

  // ---- Cloudflare R2 ----
  /** Object storage for voice samples, avatars, and other binary blobs. */
  BLOB: RuntimeR2Bucket;

  // ---- ElevenLabs ----
  ELEVENLABS_API_KEY?: string;

  // ---- AI providers ----
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  /**
   * Public hostname that serves the BLOB R2 bucket. Used to construct sample
   * URLs returned to clients. Defaults to "blob.elizacloud.ai" if unset.
   */
  R2_PUBLIC_HOST?: string;
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
  RPC_URL?: string;
  CHAIN_ID?: string;

  // ---- Redis (Upstash REST in cloud, Wadis embedded locally) ----
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;

  // ---- Stripe ----
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_CURRENCY?: string;

  // ---- Crypto payments ----
  OXAPAY_WEBHOOK_IPS?: string;
  OXAPAY_MERCHANT_API_KEY?: string;

  // ---- Cron auth ----
  CRON_SECRET?: string;

  // ---- App config ----
  NEXT_PUBLIC_APP_URL?: string;
  NEXT_PUBLIC_API_URL?: string;
  ELIZA_APP_WEBHOOK_GATEWAY_URL?: string;
  WEBHOOK_GATEWAY_URL?: string;
  GATEWAY_WEBHOOK_URL?: string;
  ELIZA_APP_WEBHOOK_PROJECT?: string;
  ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL?: string;
  DISCORD_WEBHOOK_HANDLER_URL?: string;
  CONTAINER_CONTROL_PLANE_URL?: string;
  HETZNER_CONTAINER_CONTROL_PLANE_URL?: string;
  CONTAINER_CONTROL_PLANE_TOKEN?: string;
  VERTEX_TUNING_CONTROL_PLANE_URL?: string;
  VERTEX_TUNING_HANDLER_URL?: string;
  VERTEX_TUNING_CONTROL_PLANE_TOKEN?: string;
  N8N_BRIDGE_CONTROL_PLANE_URL?: string;
  N8N_BRIDGE_URL?: string;
  N8N_BRIDGE_CONTROL_PLANE_TOKEN?: string;
  NODE_ENV?: string;

  // ---- Feature flags ----
  REDIS_RATE_LIMITING?: string;
  RATE_LIMIT_DISABLED?: string;
  RATE_LIMIT_MULTIPLIER?: string;
  PLAYWRIGHT_TEST_AUTH?: string;
  PLAYWRIGHT_TEST_AUTH_SECRET?: string;
  TWILIO_SMS_COST_PER_SEGMENT_USD?: string;

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
  organization_id?: string | null;
  organization?: { id: string; name?: string; is_active?: boolean } | null;
  is_active?: boolean;
  role?: string;
  steward_id?: string | null;
  wallet_address?: string | null;
  is_anonymous?: boolean;
}

/**
 * Per-request dependency container — populated by the composition middleware
 * in `apps/api/src/composition/build-container.ts`, consumed by routes as
 * `c.var.deps.<useCase>.execute(...)`.
 *
 * As aggregates migrate to Clean Architecture, use case properties are added
 * to this interface (e.g., `issueApiKey: IssueApiKeyUseCase`). Phase A ships
 * the empty interface — no use cases migrated yet, container is `{}`.
 */
export interface CompositionContext {}

export interface Variables {
  user: AuthedUser | null | undefined;
  authMethod?: "session" | "api_key" | "wallet_signature" | "anonymous";
  requestId: string;
  /**
   * Per-request use-case container. Always set by the composition middleware
   * mounted in `apps/api/src/bootstrap-app.ts`. Empty until Phase B; after
   * that, contains use cases per migrated aggregate.
   */
  deps: CompositionContext;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type AppContext = Context<AppEnv>;

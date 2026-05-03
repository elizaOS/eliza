/**
 * Composition root — wires per-request dependencies.
 *
 * Called once per request from `bootstrap-app.ts` via the cache/composition
 * middleware. The result is stored on Hono context as `c.var.deps` and
 * consumed by route handlers as `c.var.deps.<useCase>.execute(...)`.
 *
 * Layering: this is the ONLY place that knows about all three layers
 * (domain interfaces, infrastructure adapters/decorators, application use
 * cases). Routes never instantiate use cases or repositories directly.
 *
 * Aggregates are added incrementally as they migrate during the Clean
 * Architecture refactor (see plan). Phase A ships an empty container —
 * routes still use legacy service singletons. Phase B onwards populates
 * `CompositionContext` with use cases per aggregate.
 */

import type { Bindings } from "@/types/cloud-worker-env";

/**
 * Per-request dependency container, keyed by use-case identifier.
 *
 * As aggregates migrate, properties are added here:
 *   issueApiKey: IssueApiKeyUseCase
 *   validateApiKey: ValidateApiKeyUseCase
 *   findOrCreateUserByWalletAddress: FindOrCreateUserByWalletAddressUseCase
 *   ...
 *
 * Phase A: empty (no use cases migrated yet).
 */
export interface CompositionContext {}

/**
 * Build a fresh container from the request env. Pure factory — no global
 * mutable state, no module-level instances.
 *
 * `env` is typed as the Worker `Bindings` type so the function compiles
 * against the full env shape; concrete adapters consume only the keys they
 * need (DATABASE_URL, KV_REST_API_URL, etc.).
 */
export function buildContainer(_env: Bindings): CompositionContext {
  return {};
}

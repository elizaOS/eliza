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
 * Architecture refactor (see plan). Phase B onwards populates
 * `CompositionContext` with use cases per aggregate.
 *
 * Cache injection: today consumes the legacy module-level `cache` singleton
 * (which is a no-op in prod since `CACHE_ENABLED=false`). Phase D refactors
 * `CacheClient` to be per-request and replaces the singleton import with
 * `new CacheClient(env)`.
 */

import { cache } from "@/lib/cache/client";
import { DeactivateApiKeysByNameUseCase } from "@/lib/application/api-key/deactivate-api-keys-by-name";
import { DeleteApiKeyUseCase } from "@/lib/application/api-key/delete-api-key";
import { GetApiKeyByIdUseCase } from "@/lib/application/api-key/get-api-key-by-id";
import { IncrementApiKeyUsageUseCase } from "@/lib/application/api-key/increment-api-key-usage";
import { IssueApiKeyUseCase } from "@/lib/application/api-key/issue-api-key";
import { ListApiKeysByOrganizationUseCase } from "@/lib/application/api-key/list-api-keys-by-organization";
import { UpdateApiKeyUseCase } from "@/lib/application/api-key/update-api-key";
import { ValidateApiKeyUseCase } from "@/lib/application/api-key/validate-api-key";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";
import { CachedApiKeyRepository } from "@/lib/infrastructure/cache/api-key/cached-api-key-repository";
import { PostgresApiKeyRepository } from "@/lib/infrastructure/db/api-key/postgres-api-key-repository";
import type { Bindings } from "@/types/cloud-worker-env";

export interface CompositionContext {
  // ── ApiKey aggregate (Phase B) ────────────────────────────────────────
  issueApiKey: IssueApiKeyUseCase;
  validateApiKey: ValidateApiKeyUseCase;
  incrementApiKeyUsage: IncrementApiKeyUsageUseCase;
  getApiKeyById: GetApiKeyByIdUseCase;
  listApiKeysByOrganization: ListApiKeysByOrganizationUseCase;
  updateApiKey: UpdateApiKeyUseCase;
  deleteApiKey: DeleteApiKeyUseCase;
  deactivateApiKeysByName: DeactivateApiKeysByNameUseCase;
}

export function buildContainer(_env: Bindings): CompositionContext {
  const apiKeyRepo: ApiKeyRepository = new CachedApiKeyRepository(
    new PostgresApiKeyRepository(),
    cache,
  );

  return {
    issueApiKey: new IssueApiKeyUseCase(apiKeyRepo),
    validateApiKey: new ValidateApiKeyUseCase(apiKeyRepo),
    incrementApiKeyUsage: new IncrementApiKeyUsageUseCase(apiKeyRepo),
    getApiKeyById: new GetApiKeyByIdUseCase(apiKeyRepo),
    listApiKeysByOrganization: new ListApiKeysByOrganizationUseCase(apiKeyRepo),
    updateApiKey: new UpdateApiKeyUseCase(apiKeyRepo),
    deleteApiKey: new DeleteApiKeyUseCase(apiKeyRepo),
    deactivateApiKeysByName: new DeactivateApiKeysByNameUseCase(apiKeyRepo),
  };
}

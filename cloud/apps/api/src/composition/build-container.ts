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
import { CreateOrganizationUseCase } from "@/lib/application/organization/create-organization";
import { DeleteOrganizationUseCase } from "@/lib/application/organization/delete-organization";
import { GetOrganizationByIdUseCase } from "@/lib/application/organization/get-organization-by-id";
import { GetOrganizationBySlugUseCase } from "@/lib/application/organization/get-organization-by-slug";
import { GetOrganizationByStripeCustomerIdUseCase } from "@/lib/application/organization/get-organization-by-stripe-customer-id";
import { GetOrganizationWithUsersUseCase } from "@/lib/application/organization/get-organization-with-users";
import { UpdateOrganizationUseCase } from "@/lib/application/organization/update-organization";
import { UpdateOrganizationCreditBalanceUseCase } from "@/lib/application/organization/update-organization-credit-balance";
import { CreateUserUseCase } from "@/lib/application/user/create-user";
import { DeleteUserUseCase } from "@/lib/application/user/delete-user";
import { GetUserByEmailUseCase } from "@/lib/application/user/get-user-by-email";
import { GetUserByIdUseCase } from "@/lib/application/user/get-user-by-id";
import { GetUserByStewardIdUseCase } from "@/lib/application/user/get-user-by-steward-id";
import { GetUserWithOrganizationUseCase } from "@/lib/application/user/get-user-with-organization";
import { ListUsersByOrganizationUseCase } from "@/lib/application/user/list-users-by-organization";
import { UpdateUserUseCase } from "@/lib/application/user/update-user";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";
import type { UserRepository } from "@/lib/domain/user/user-repository";
import { CachedApiKeyRepository } from "@/lib/infrastructure/cache/api-key/cached-api-key-repository";
import { CachedOrganizationRepository } from "@/lib/infrastructure/cache/organization/cached-organization-repository";
import { CachedUserRepository } from "@/lib/infrastructure/cache/user/cached-user-repository";
import { PostgresApiKeyRepository } from "@/lib/infrastructure/db/api-key/postgres-api-key-repository";
import { PostgresOrganizationRepository } from "@/lib/infrastructure/db/organization/postgres-organization-repository";
import { PostgresUserRepository } from "@/lib/infrastructure/db/user/postgres-user-repository";
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

  // ── Organization aggregate (Phase C.1) ────────────────────────────────
  getOrganizationById: GetOrganizationByIdUseCase;
  getOrganizationBySlug: GetOrganizationBySlugUseCase;
  getOrganizationByStripeCustomerId: GetOrganizationByStripeCustomerIdUseCase;
  getOrganizationWithUsers: GetOrganizationWithUsersUseCase;
  createOrganization: CreateOrganizationUseCase;
  updateOrganization: UpdateOrganizationUseCase;
  updateOrganizationCreditBalance: UpdateOrganizationCreditBalanceUseCase;
  deleteOrganization: DeleteOrganizationUseCase;

  // ── User aggregate (Phase C.2) ────────────────────────────────────────
  getUserById: GetUserByIdUseCase;
  getUserByEmail: GetUserByEmailUseCase;
  getUserByStewardId: GetUserByStewardIdUseCase;
  getUserWithOrganization: GetUserWithOrganizationUseCase;
  listUsersByOrganization: ListUsersByOrganizationUseCase;
  createUser: CreateUserUseCase;
  updateUser: UpdateUserUseCase;
  deleteUser: DeleteUserUseCase;
}

export function buildContainer(_env: Bindings): CompositionContext {
  const apiKeyRepo: ApiKeyRepository = new CachedApiKeyRepository(
    new PostgresApiKeyRepository(),
    cache,
  );
  const organizationRepo: OrganizationRepository =
    new CachedOrganizationRepository(
      new PostgresOrganizationRepository(),
      cache,
    );
  const userRepo: UserRepository = new CachedUserRepository(
    new PostgresUserRepository(),
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

    getOrganizationById: new GetOrganizationByIdUseCase(organizationRepo),
    getOrganizationBySlug: new GetOrganizationBySlugUseCase(organizationRepo),
    getOrganizationByStripeCustomerId:
      new GetOrganizationByStripeCustomerIdUseCase(organizationRepo),
    getOrganizationWithUsers: new GetOrganizationWithUsersUseCase(
      organizationRepo,
    ),
    createOrganization: new CreateOrganizationUseCase(organizationRepo),
    updateOrganization: new UpdateOrganizationUseCase(organizationRepo),
    updateOrganizationCreditBalance: new UpdateOrganizationCreditBalanceUseCase(
      organizationRepo,
    ),
    deleteOrganization: new DeleteOrganizationUseCase(organizationRepo),

    getUserById: new GetUserByIdUseCase(userRepo),
    getUserByEmail: new GetUserByEmailUseCase(userRepo),
    getUserByStewardId: new GetUserByStewardIdUseCase(userRepo),
    getUserWithOrganization: new GetUserWithOrganizationUseCase(userRepo),
    listUsersByOrganization: new ListUsersByOrganizationUseCase(userRepo),
    createUser: new CreateUserUseCase(userRepo),
    updateUser: new UpdateUserUseCase(userRepo),
    deleteUser: new DeleteUserUseCase(userRepo),
  };
}

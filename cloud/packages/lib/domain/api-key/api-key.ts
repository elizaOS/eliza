/**
 * ApiKey domain entity.
 *
 * Re-exports the Drizzle-inferred type from the schema. This is a pragmatic
 * choice — the entity shape and the persistence row shape are identical
 * today, and duplicating the type would just create drift. If the entity
 * grows business-only fields not stored in the DB, redefine here and have
 * the postgres adapter translate.
 *
 * The domain layer is allowed to depend on `@/db/schemas/*` for type-only
 * imports — those are pure shape declarations with no runtime cost. It is
 * NOT allowed to depend on `@/db/repositories/*` (those touch DB) or
 * `@/lib/cache/*` (infrastructure).
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { apiKeys } from "@/db/schemas/api-keys";

export type ApiKey = InferSelectModel<typeof apiKeys>;
export type NewApiKey = InferInsertModel<typeof apiKeys>;

/**
 * Input shape accepted by `IssueApiKeyUseCase` (and the underlying repository
 * `create` method). The `key`, `key_hash`, and `key_prefix` are derived in
 * the use case and not part of the caller-provided input.
 */
export type CreateApiKeyInput = Omit<
  NewApiKey,
  "key" | "key_hash" | "key_prefix"
>;

/**
 * Result of generating a new API key — used by `IssueApiKeyUseCase` to
 * compose the `key/hash/prefix` triple before persisting.
 */
export interface GeneratedApiKey {
  key: string;
  hash: string;
  prefix: string;
}

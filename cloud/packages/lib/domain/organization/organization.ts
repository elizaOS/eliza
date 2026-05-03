/**
 * Organization domain entity.
 *
 * Re-exports the Drizzle-inferred type from the schema (same pragmatic
 * choice as `ApiKey` — entity shape and persistence row shape are
 * identical, duplicating the type would just create drift).
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { organizations } from "@/db/schemas/organizations";

export type Organization = InferSelectModel<typeof organizations>;
export type NewOrganization = InferInsertModel<typeof organizations>;

/**
 * Result shape for `UpdateOrganizationCreditBalanceUseCase`.
 */
export interface UpdateCreditBalanceResult {
  success: boolean;
  newBalance: number;
}

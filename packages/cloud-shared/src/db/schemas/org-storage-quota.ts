import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { bigint, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Per-organization attachment-storage quota.
 *
 * Tracks bytes used and the byte limit for the `/v1/apis/storage/*` proxy.
 * One row per organization. Default limit is 5 GiB for the free tier;
 * paid tiers update the row in place.
 *
 * `bytes_used` is updated atomically on PUT (increment) and DELETE
 * (decrement). The proxy hard-rejects writes that would exceed
 * `bytes_limit` with a 413 — there is no soft-limit grace.
 */
export const orgStorageQuota = pgTable(
  "org_storage_quota",
  {
    organization_id: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),

    bytes_used: bigint("bytes_used", { mode: "bigint" }).notNull().default(0n),

    bytes_limit: bigint("bytes_limit", { mode: "bigint" })
      .notNull()
      .default(5n * 1024n * 1024n * 1024n),

    created_at: timestamp("created_at").notNull().defaultNow(),

    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    bytes_used_idx: index("org_storage_quota_bytes_used_idx").on(table.bytes_used),
  }),
);

export type OrgStorageQuota = InferSelectModel<typeof orgStorageQuota>;
export type NewOrgStorageQuota = InferInsertModel<typeof orgStorageQuota>;

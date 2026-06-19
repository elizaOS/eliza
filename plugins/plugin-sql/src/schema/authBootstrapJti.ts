import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Replay-defence set for bootstrap-token `jti` claims. A row exists for every
 * bootstrap token successfully verified on this instance; subsequent
 * presentations of the same `jti` must be rejected.
 *
 * Rows are kept until natural `exp` of the original token plus a buffer; the
 * cleanup job lives in the auth-store.
 */
export const authBootstrapJtiSeenTable = pgTable(
  "auth_bootstrap_jti_seen",
  {
    jti: text("jti").primaryKey(),
    seenAt: bigint("seen_at", { mode: "number" }).notNull(),
  },
  (table) => [index("auth_bootstrap_jti_seen_at_idx").on(table.seenAt)]
);

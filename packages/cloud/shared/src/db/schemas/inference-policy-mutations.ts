/** Durable policy publication receipts for enrolled inference escrow authorities. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const inferencePolicyAuthorities = pgTable(
  "inference_policy_authorities",
  {
    organization_id: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(false),
    epoch: bigint("epoch", { mode: "bigint" }).notNull().default(0n),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("inference_policy_authorities_epoch_check", sql`${table.epoch} >= 0`)],
);

export const inferencePolicyMutations = pgTable(
  "inference_policy_mutations",
  {
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    mutation_id: text("mutation_id").notNull(),
    fence_token: text("fence_token").notNull(),
    permit_expires_at: timestamp("permit_expires_at", { withTimezone: true }).notNull(),
    applying_txid: bigint("applying_txid", { mode: "bigint" }).notNull(),
    phase: text("phase").$type<"applying" | "applied" | "complete">().notNull(),
    epoch: bigint("epoch", { mode: "bigint" }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organization_id, table.mutation_id] }),
    check(
      "inference_policy_mutations_phase_check",
      sql`${table.phase} IN ('applying', 'applied', 'complete')`,
    ),
    check(
      "inference_policy_mutations_identity_check",
      sql`length(${table.mutation_id}) BETWEEN 1 AND 128 AND length(${table.fence_token}) > 0`,
    ),
    check(
      "inference_policy_mutations_epoch_check",
      sql`(${table.phase} = 'applying' AND ${table.epoch} IS NULL) OR (${table.phase} IN ('applied', 'complete') AND ${table.epoch} >= 1)`,
    ),
  ],
);

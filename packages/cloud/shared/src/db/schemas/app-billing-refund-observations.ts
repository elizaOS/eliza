/** Retains immutable provider refund observations against original administration commands without changing access or creating another execution journal. */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { BillingProviderObservation } from "../../lib/services/generic-billing-provider-types";
import { billingSubscriptionCommands } from "./subscription-billing-operations";

export interface AppBillingRefundObservationValue {
  refundId: string;
  chargeId: string;
  amountCents: number;
  currency: string;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled" | null;
}
export const appBillingRefundObservations = pgTable(
  "app_billing_refund_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    observation_sequence: bigserial("observation_sequence", { mode: "number" })
      .notNull()
      .unique("app_billing_refund_observations_sequence_unique"),
    command_id: uuid("command_id").notNull(),
    request_id: uuid("request_id").notNull(),
    request_digest: text("request_digest").notNull(),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull(),
    phase_receipt_id: uuid("phase_receipt_id").notNull(),
    phase_generation: bigint("phase_generation", { mode: "number" }).notNull(),
    command_revision: bigint("command_revision", { mode: "number" }).notNull(),
    execution_generation: bigint("execution_generation", { mode: "number" }).notNull(),
    observation: jsonb("observation")
      .$type<BillingProviderObservation<AppBillingRefundObservationValue>>()
      .notNull(),
    discovery:
      jsonb("discovery").$type<
        BillingProviderObservation<{ status: "found"; object: AppBillingRefundObservationValue }>
      >(),
    created_at: timestamp("created_at", { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (t) => ({
    command: foreignKey({
      columns: [t.command_id],
      foreignColumns: [billingSubscriptionCommands.id],
      name: "app_billing_refund_observations_command_fk",
    }).onDelete("restrict"),
    recent: index("app_billing_refund_observations_command_idx").on(
      t.command_id,
      t.observation_sequence,
    ),
  }),
);

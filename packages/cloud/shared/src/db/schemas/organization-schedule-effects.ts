/** Ordered provider request and receipt identity; the original command owns the execution lease. */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  OrganizationScheduleEffectReceipt,
  OrganizationScheduleEffectRequest,
} from "../../lib/services/organization-schedule-effect-contract";
import { organizations } from "./organizations";
import { billingSubscriptionCommands } from "./subscription-billing-operations";
export const organizationScheduleEffects = pgTable(
  "organization_schedule_effects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    command_id: uuid("command_id").notNull(),
    predecessor_id: uuid("predecessor_id").references(
      (): AnyPgColumn => organizationScheduleEffects.id,
      { onDelete: "restrict" },
    ),
    kind: text("kind").$type<OrganizationScheduleEffectRequest["kind"]>().notNull(),
    provider_idempotency_key: text("provider_idempotency_key").notNull(),
    customer_id: text("customer_id").notNull(),
    subscription_id: text("subscription_id").notNull(),
    livemode: boolean("livemode").notNull(),
    request_payload: jsonb("request_payload").$type<OrganizationScheduleEffectRequest>().notNull(),
    request_digest: text("request_digest").notNull(),
    state: text("state").$type<"ready" | "started" | "observed">().notNull().default("ready"),
    started_at: timestamp("started_at", { withTimezone: true }),
    started_generation: bigint("started_generation", { mode: "number" }),
    started_lease_token: uuid("started_lease_token"),
    receipt: jsonb("receipt").$type<OrganizationScheduleEffectReceipt>(),
    receipt_digest: text("receipt_digest"),
    observed_at: timestamp("observed_at", { withTimezone: true }),
    observation_generation: bigint("observation_generation", { mode: "number" }),
    observation_lease_token: uuid("observation_lease_token"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    command: foreignKey({
      name: "organization_schedule_effect_command_fk",
      columns: [t.command_id, t.organization_id],
      foreignColumns: [billingSubscriptionCommands.id, billingSubscriptionCommands.organization_id],
    }).onDelete("restrict"),
    commandKind: uniqueIndex("organization_schedule_effect_command_kind").on(t.command_id, t.kind),
    providerKey: uniqueIndex("organization_schedule_effect_provider_key").on(
      t.provider_idempotency_key,
    ),
    identity: check(
      "organization_schedule_effect_identity",
      sql`(${t.customer_id} ~ '^cus_[A-Za-z0-9]+$' AND ${t.subscription_id} ~ '^sub_[A-Za-z0-9]+$' AND ${t.request_digest} ~ '^[a-f0-9]{64}$' AND ${t.provider_idempotency_key}='organization-schedule:'||${t.command_id}::text||':'||${t.kind} AND ${t.request_payload}->>'kind'=${t.kind} AND jsonb_typeof(${t.request_payload})='object' AND ((${t.kind}='schedule_create' AND ${t.predecessor_id} IS NULL AND ${t.request_payload}->>'subscriptionId'=${t.subscription_id} AND ${t.request_payload}-ARRAY['kind','subscriptionId']='{}'::jsonb) OR (${t.kind} IN ('schedule_configure','schedule_release') AND ${t.predecessor_id} IS NOT NULL AND ${t.request_payload}->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$' AND jsonb_typeof(${t.request_payload}->'params')='object' AND ${t.request_payload}-ARRAY['kind','scheduleId','params']='{}'::jsonb AND (${t.kind}<>'schedule_release' OR ${t.request_payload}->'params'='{"preserve_cancel_date":true}'::jsonb)))) IS TRUE`,
    ),
    stateShape: check(
      "organization_schedule_effect_state",
      sql`((state='ready' AND started_at IS NULL AND started_generation IS NULL AND started_lease_token IS NULL AND receipt IS NULL AND receipt_digest IS NULL AND observed_at IS NULL AND observation_generation IS NULL AND observation_lease_token IS NULL) OR (state='started' AND started_at>=created_at AND started_generation>0 AND started_lease_token IS NOT NULL AND receipt IS NULL AND receipt_digest IS NULL AND observed_at IS NULL AND observation_generation IS NULL AND observation_lease_token IS NULL) OR (state='observed' AND started_at>=created_at AND started_generation>0 AND started_lease_token IS NOT NULL AND receipt IS NOT NULL AND receipt_digest ~ '^[a-f0-9]{64}$' AND observed_at>=started_at AND observation_generation>=started_generation AND observation_lease_token IS NOT NULL)) IS TRUE`,
    ),
    receiptShape: check(
      "organization_schedule_effect_receipt",
      sql`receipt IS NULL OR (jsonb_typeof(receipt)='object' AND receipt-ARRAY['kind','scheduleId','customerId','subscriptionId','livemode','apiVersion','providerRequestId','providerIdempotencyKey','eventId','evidenceDigest','observedAt']='{}'::jsonb AND receipt->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$' AND receipt->>'customerId'=customer_id AND receipt->>'subscriptionId'=subscription_id AND receipt->'livemode'=to_jsonb(livemode) AND receipt->>'apiVersion'='2024-11-20.acacia' AND receipt->>'providerRequestId' ~ '^req_[A-Za-z0-9]+$' AND receipt->>'providerIdempotencyKey'=provider_idempotency_key AND receipt->>'evidenceDigest' ~ '^[a-f0-9]{64}$' AND (receipt->>'observedAt')::timestamptz=observed_at AND ((receipt->>'kind'='response' AND receipt->'eventId'='null'::jsonb) OR (receipt->>'kind'='event' AND receipt->>'eventId' ~ '^evt_[A-Za-z0-9]+$'))) IS TRUE`,
    ),
  }),
);

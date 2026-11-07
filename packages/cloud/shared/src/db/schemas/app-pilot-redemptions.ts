/** Sponsored pilot admission history, separate from paid invoices and service funding. */
import { type InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appBillingPlanRevisions, appBillingScopes } from "./app-billing";
import { apps } from "./apps";
import { billingEligibilityPrincipals, billingIdentitySubjects } from "./billing-identities";

export const appPilotCampaigns = pgTable(
  "app_pilot_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    plan_revision_id: uuid("plan_revision_id")
      .notNull()
      .references(() => appBillingPlanRevisions.id, { onDelete: "restrict" }),
    livemode: boolean("livemode").notNull(),
    code_digest: text("code_digest").notNull(),
    maximum_redemptions: integer("maximum_redemptions").notNull(),
    opens_at: timestamp("opens_at", { withTimezone: true }).notNull(),
    closes_at: timestamp("closes_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.app_id, t.livemode, t.code_digest),
    check("app_pilot_campaigns_code_digest_check", sql`${t.code_digest} ~ '^[0-9a-f]{64}$'`),
    check("app_pilot_campaigns_maximum_redemptions_check", sql`${t.maximum_redemptions} > 0`),
    check("app_pilot_campaigns_check", sql`${t.closes_at} > ${t.opens_at}`),
  ],
);

export const appPilotInvitations = pgTable(
  "app_pilot_invitations",
  {
    campaign_id: uuid("campaign_id")
      .notNull()
      .references(() => appPilotCampaigns.id, { onDelete: "restrict" }),
    eligibility_principal_id: uuid("eligibility_principal_id")
      .notNull()
      .references(() => billingEligibilityPrincipals.id, { onDelete: "restrict" }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.campaign_id, t.eligibility_principal_id] })],
);

export const appPilotRedemptions = pgTable(
  "app_pilot_redemptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaign_id: uuid("campaign_id")
      .notNull()
      .references(() => appPilotCampaigns.id, { onDelete: "restrict" }),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "restrict" }),
    livemode: boolean("livemode").notNull(),
    eligibility_principal_id: uuid("eligibility_principal_id")
      .notNull()
      .references(() => billingEligibilityPrincipals.id, { onDelete: "restrict" }),
    billing_scope_id: uuid("billing_scope_id")
      .notNull()
      .references(() => appBillingScopes.id, { onDelete: "restrict" }),
    plan_revision_id: uuid("plan_revision_id")
      .notNull()
      .references(() => appBillingPlanRevisions.id, { onDelete: "restrict" }),
    redeemed_by_user_id: uuid("redeemed_by_user_id")
      .notNull()
      .references(() => billingIdentitySubjects.id, { onDelete: "restrict" }),
    starts_at: timestamp("starts_at", { withTimezone: true }).notNull(),
    ends_at: timestamp("ends_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique().on(t.app_id, t.livemode, t.eligibility_principal_id),
    foreignKey({
      columns: [t.campaign_id, t.eligibility_principal_id],
      foreignColumns: [
        appPilotInvitations.campaign_id,
        appPilotInvitations.eligibility_principal_id,
      ],
    }).onDelete("restrict"),
    check(
      "app_pilot_redemptions_check",
      sql`${t.ends_at} = ((${t.starts_at} AT TIME ZONE 'UTC') + interval '6 months') AT TIME ZONE 'UTC'`,
    ),
    index("app_pilot_redemptions_scope_idx").on(t.billing_scope_id),
    index("app_pilot_redemptions_campaign_idx").on(t.campaign_id),
  ],
);

export type AppPilotRedemption = InferSelectModel<typeof appPilotRedemptions>;

export const appPilotActivations = pgTable("app_pilot_activations", {
  redemption_id: uuid("redemption_id")
    .primaryKey()
    .references(() => appPilotRedemptions.id, { onDelete: "restrict" }),
  activated_at: timestamp("activated_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

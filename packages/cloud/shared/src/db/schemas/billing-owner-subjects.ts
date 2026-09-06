/** Retains original billing ownership without retaining operational credentials or granting access. Live links may detach; historical organization, app and registration relationships remain immutable. */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appClientRegistrations } from "./app-delegations";
import { apps } from "./apps";
import { organizations } from "./organizations";

export const billingOrganizationSubjects = pgTable(
  "billing_organization_subjects",
  {
    id: uuid("id").primaryKey(),
    live_organization_id: uuid("live_organization_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    liveOrganization: foreignKey({
      name: "billing_organization_subjects_live_organization_id_fkey",
      columns: [t.live_organization_id],
      foreignColumns: [organizations.id],
    }).onDelete("set null"),
    live: uniqueIndex("billing_organization_subjects_live_idx").on(t.live_organization_id),
    identity: check(
      "billing_organization_subjects_identity",
      sql`${t.live_organization_id} IS NULL OR ${t.live_organization_id}=${t.id}`,
    ),
  }),
);

export const billingAppSubjects = pgTable(
  "billing_app_subjects",
  {
    id: uuid("id").primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    live_app_id: uuid("live_app_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    organization: foreignKey({
      name: "billing_app_subjects_organization_id_fkey",
      columns: [t.organization_id],
      foreignColumns: [billingOrganizationSubjects.id],
    }).onDelete("restrict"),
    liveApp: foreignKey({
      name: "billing_app_subjects_live_app_id_fkey",
      columns: [t.live_app_id],
      foreignColumns: [apps.id],
    }).onDelete("set null"),
    live: uniqueIndex("billing_app_subjects_live_idx").on(t.live_app_id),
    owner: unique("billing_app_subjects_owner_key").on(t.id, t.organization_id),
    identity: check(
      "billing_app_subjects_identity",
      sql`${t.live_app_id} IS NULL OR ${t.live_app_id}=${t.id}`,
    ),
  }),
);

export const billingRegistrationSubjects = pgTable(
  "billing_registration_subjects",
  {
    id: uuid("id").primaryKey(),
    app_id: uuid("app_id").notNull(),
    organization_id: uuid("organization_id").notNull(),
    live_registration_id: uuid("live_registration_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    liveRegistration: foreignKey({
      name: "billing_registration_subjects_live_registration_id_fkey",
      columns: [t.live_registration_id],
      foreignColumns: [appClientRegistrations.id],
    }).onDelete("set null"),
    live: uniqueIndex("billing_registration_subjects_live_idx").on(t.live_registration_id),
    registrationApp: unique("billing_registration_subjects_id_app_key").on(t.id, t.app_id),
    app: foreignKey({
      name: "billing_registration_subjects_app_owner_fk",
      columns: [t.app_id, t.organization_id],
      foreignColumns: [billingAppSubjects.id, billingAppSubjects.organization_id],
    }).onDelete("restrict"),
    identity: check(
      "billing_registration_subjects_identity",
      sql`${t.live_registration_id} IS NULL OR ${t.live_registration_id}=${t.id}`,
    ),
  }),
);

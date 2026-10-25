/** Defines shared phone-gateway devices with typed authentication and routing metadata. */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { phoneProviderEnum } from "./agent-phone-numbers";

/**
 * Shared phone gateway devices.
 *
 * Unlike agent_phone_numbers, these records are not bound to a single agent.
 * They represent physical or bridge-backed gateway numbers that Cloud routes
 * dynamically by sender identity and contact relationships.
 */
export const phoneGatewayDevices = pgTable(
  "phone_gateway_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id"),
    provider: phoneProviderEnum("provider").notNull(),
    phone_number: text("phone_number").notNull(),
    bridge_id: text("bridge_id").notNull().default("default"),
    phone_account_id: text("phone_account_id"),
    phone_account_label: text("phone_account_label"),
    friendly_name: text("friendly_name"),
    send_method: text("send_method"),
    cloud_webhook_url: text("cloud_webhook_url"),
    local_webhook_url: text("local_webhook_url"),
    is_active: boolean("is_active").notNull().default(true),
    can_send_sms: boolean("can_send_sms").notNull().default(true),
    can_receive_sms: boolean("can_receive_sms").notNull().default(true),
    can_send_imessage: boolean("can_send_imessage").notNull().default(true),
    can_receive_imessage: boolean("can_receive_imessage").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at"),
  },
  (table) => ({
    provider_phone_bridge_idx: uniqueIndex("phone_gateway_devices_provider_phone_bridge_idx").on(
      table.provider,
      table.phone_number,
      table.bridge_id,
    ),
    organization_idx: index("phone_gateway_devices_organization_idx").on(table.organization_id),
    phone_number_idx: index("phone_gateway_devices_phone_number_idx").on(table.phone_number),
    is_active_idx: index("phone_gateway_devices_is_active_idx").on(table.is_active),
    metadata_object_check: check(
      "phone_gateway_devices_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export type PhoneGatewayDevice = InferSelectModel<typeof phoneGatewayDevices>;
export type NewPhoneGatewayDevice = InferInsertModel<typeof phoneGatewayDevices>;

/**
 * Cross-device intent bus schemas.
 *
 * `devices` — paired devices per user (Mac + phone etc.) with presence + push
 *   token for later push fan-out.
 * `device_intents` — published intents (alarm, reminder, block, ...) that
 *   devices subscribe to via poll. WebSocket fan-out is a follow-up.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

export const devices = pgTable(
  "device_bus_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    push_token: text("push_token"),
    label: text("label"),
    online: boolean("online").notNull().default(false),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("device_bus_devices_user_id_idx").on(table.user_id),
    lastSeenIdx: index("device_bus_devices_last_seen_idx").on(table.last_seen_at),
  }),
);

export type Device = InferSelectModel<typeof devices>;
export type NewDevice = InferInsertModel<typeof devices>;

export const deviceIntents = pgTable(
  "device_bus_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    delivered_to: jsonb("delivered_to").notNull().default([]),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index("device_bus_intents_user_created_idx").on(
      table.user_id,
      table.created_at,
    ),
    kindIdx: index("device_bus_intents_kind_idx").on(table.kind),
  }),
);

export type DeviceIntent = InferSelectModel<typeof deviceIntents>;
export type NewDeviceIntent = InferInsertModel<typeof deviceIntents>;

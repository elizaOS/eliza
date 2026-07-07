// Defines the Web Push subscription store — PushSubscription objects keyed to
// (user, agent), used by the cloud Web Push sender to notify an owner when the
// installed PWA is closed. See packages/cloud/shared/src/lib/web-push.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Web Push subscriptions.
 *
 * One row per (endpoint, agent). The browser's `PushSubscription.toJSON()`
 * produces `{ endpoint, keys: { p256dh, auth } }`; we persist those verbatim.
 * A single installed PWA (one `endpoint`) can subscribe to MULTIPLE agents, so
 * the uniqueness + upsert conflict target is the composite `(endpoint,
 * agent_id)` — keying on `endpoint` alone would let a second agent's subscribe
 * overwrite the first agent's row, silently killing that agent's pushes. The
 * push-service device id lives in `endpoint`; delete-on-unsubscribe and the
 * 404/410 prune both operate on `endpoint` (all agents for a dead device go).
 *
 * `agent_id` is a plain uuid (no FK) to match the loose agent references used
 * elsewhere in the cloud schema (agents live in a separate store).
 */
export const webPushSubscriptions = pgTable(
  "web_push_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Owner of the installed PWA / browser that subscribed.
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Agent this subscription wants notifications for.
    agent_id: uuid("agent_id").notNull(),

    // PushSubscription.endpoint — unique per browser+device install.
    endpoint: text("endpoint").notNull(),

    // PushSubscription.keys.p256dh — base64url UA public key.
    p256dh: text("p256dh").notNull(),

    // PushSubscription.keys.auth — base64url 16-byte auth secret.
    auth: text("auth").notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // (endpoint, agent) is unique — one device may subscribe to many agents.
    // This is the upsert conflict target so a repeat subscribe for the SAME
    // agent+device refreshes keys, while a NEW agent on the same device adds a
    // row instead of clobbering the existing one.
    endpoint_agent_uidx: uniqueIndex("web_push_subscriptions_endpoint_agent_uidx").on(
      table.endpoint,
      table.agent_id,
    ),
    user_agent_idx: index("web_push_subscriptions_user_agent_idx").on(
      table.user_id,
      table.agent_id,
    ),
    user_idx: index("web_push_subscriptions_user_idx").on(table.user_id),
    // Prune-by-endpoint (404/410 gone) removes the device across all agents.
    endpoint_idx: index("web_push_subscriptions_endpoint_idx").on(table.endpoint),
  }),
);

export type WebPushSubscription = InferSelectModel<typeof webPushSubscriptions>;
export type NewWebPushSubscription = InferInsertModel<typeof webPushSubscriptions>;

/** Memberless organizations that own durable native app registrations. */
import { pgTable, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const nativeAppPublishers = pgTable("native_app_publishers", {
  organization_id: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "restrict" }),
});

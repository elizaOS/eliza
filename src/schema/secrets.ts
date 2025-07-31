import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

export const keyType = pgEnum("key_type", ["api_key"]);

export const secretsTable = pgTable(
  "levva_secrets",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hash: varchar("hash", { length: 66 }).notNull(),
    type: keyType("type").notNull(),
    description: text("description").notNull(),
  },
  (table) => [
    index("levva_secrets_hash_index").on(table.hash),
  ]
);

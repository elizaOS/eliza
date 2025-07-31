import { pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { lower } from "./util";
import { secretsTable } from "./secrets";

export const levvaUserTable = pgTable(
  "levva_user",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    address: text("address").unique().notNull(),
    creatorId: uuid("creator_id").references(() => secretsTable.id).notNull(),
  },
  (table) => [uniqueIndex("userAddressIndex").on(lower(table.address))]
);

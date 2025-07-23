import {
  pgTable,
  integer,
  text,
  index,
  json,
  varchar,
  primaryKey,
  uuid,
  unique,
} from "drizzle-orm/pg-core";
import { lower } from "./util";
import { sql } from "drizzle-orm";

export const erc20Table = pgTable(
  "erc20",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    address: varchar("address", { length: 42 }).notNull(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull(),
    chainId: integer("chain_id").notNull(),
    info: json("info"),
  },
  (table) => [
    unique().on(table.address, table.chainId, table.symbol),
    index("addressIndex").on(table.address),
    index("tokenSymbolIndex").on(lower(table.symbol)),
    index("chainIdIndex").on(table.chainId),
  ]
);

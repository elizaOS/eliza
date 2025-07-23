import { sql } from "drizzle-orm";
import {
  pgTable,
  integer,
  uuid,
  pgEnum,
  varchar,
  decimal,
  unique,
  index,
  timestamp,
} from "drizzle-orm/pg-core";
import { ETH_NULL_ADDR } from "src/constants/eth";

export const assetType = pgEnum("asset_type", ["native", "erc20"]);

export const balancesTable = pgTable(
  "balances",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    address: varchar("address", { length: 42 }).notNull(),
    chainId: integer("chain_id").notNull(),
    token: varchar("token", { length: 42 }).notNull(),
    amount: decimal("amount", { mode: "bigint" }).notNull(),
    value: decimal("value", { mode: "bigint" }).notNull(),
    type: assetType("type").notNull(),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique().on(table.address, table.chainId, table.token),
    index("balanceAddressIndex").on(table.address),
    index("balanceChainIdIndex").on(table.chainId),
    index("balanceTokenIndex").on(table.token),
  ]
);

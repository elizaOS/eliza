import { pgTable, uuid, jsonb, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { entityTable } from "./entity";
import { numberTimestamp } from "./types";
import { agentTable } from "./agent";
import { roomTable } from "./room";
import { worldTable } from "./worldTable";

export const componentTable = pgTable("components", {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entityId").notNull().references(() => entityTable.id),
    agentId: uuid("agentId").notNull().references(() => agentTable.id),
    roomId: uuid("roomId").notNull().references(() => roomTable.id),
    worldId: uuid("worldId").references(() => worldTable.id),
    sourceEntityId: uuid("sourceEntityId").references(() => entityTable.id),
    type: text("type").notNull(),
    data: jsonb("data").default(sql`'{}'::jsonb`),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
});
import {
    boolean,
    customType,
    integer,
    jsonb,
    pgTable,
    text,
    uuid,
    vector,
} from "drizzle-orm/pg-core";
import { getEmbeddingConfig } from "@elizaos/core";
import { sql } from "drizzle-orm";

// Const.
const DIMENSIONS = getEmbeddingConfig().dimensions;

// Custom types.
const stringJsonb = customType<{ data: string; driverData: string }>({
    dataType() {
        return "jsonb";
    },
    toDriver(value: string): string {
        return JSON.stringify(value);
    },
    fromDriver(value: string): string {
        return JSON.stringify(value);
    },
});

const numberTimestamp = customType<{ data: number; driverData: string }>({
    dataType() {
        return "timestamptz";
    },
    toDriver(value: number): string {
        return new Date(value).toISOString();
    },
    fromDriver(value: string): number {
        return new Date(value).getTime();
    },
});

// Tables.
export const accountTable = pgTable("accounts", {
    id: uuid("id").primaryKey().notNull(),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    name: text("name"),
    username: text("username"),
    email: text("email").notNull(),
    avatarUrl: text("avatarUrl"),
    details: jsonb("details").default(""),
});

export const memoryTable = pgTable("memories", {
    id: uuid("id").primaryKey().notNull(),
    type: text("type").notNull(),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    content: jsonb("content").default(""),
    embedding: vector("embedding", {
        dimensions: DIMENSIONS,
    }),
    userId: uuid("userId")
        .references(() => accountTable.id)
        .references(() => accountTable.id),
    agentId: uuid("agentId")
        .references(() => accountTable.id)
        .references(() => accountTable.id),
    roomId: uuid("roomId")
        .references(() => roomTable.id)
        .references(() => roomTable.id),
    unique: boolean("unique").default(true).notNull(),
});

export const roomTable = pgTable("rooms", {
    id: uuid("id").primaryKey().notNull(),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
});

export const goalTable = pgTable("goals", {
    id: uuid("id").primaryKey().notNull(),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    userId: uuid("userId")
        .references(() => accountTable.id)
        .references(() => accountTable.id),
    name: text("name"),
    status: text("status"),
    description: text("description"),
    roomId: uuid("roomId")
        .references(() => roomTable.id)
        .references(() => roomTable.id),
    objectives: jsonb("objectives").default(""),
});

export const logTable = pgTable("logs", {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    userId: uuid("userId")
        .notNull()
        .references(() => accountTable.id)
        .references(() => accountTable.id),
    body: jsonb("body").default(""),
    type: text("type").notNull(),
    roomId: uuid("roomId")
        .notNull()
        .references(() => roomTable.id)
        .references(() => roomTable.id),
});

export const participantTable = pgTable("participants", {
    id: uuid("id").primaryKey().notNull(),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    userId: uuid("userId")
        .references(() => accountTable.id)
        .references(() => accountTable.id),
    roomId: uuid("roomId")
        .references(() => roomTable.id)
        .references(() => roomTable.id),
    userState: text("userState"),
    lastMessageRead: text("last_message_read"),
});

export const relationshipTable = pgTable("relationships", {
    id: uuid("id").primaryKey().notNull(),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    userA: uuid("userA")
        .notNull()
        .references(() => accountTable.id)
        .references(() => accountTable.id),
    userB: uuid("userB")
        .notNull()
        .references(() => accountTable.id)
        .references(() => accountTable.id),
    status: text("status"),
    userId: uuid("userId")
        .notNull()
        .references(() => accountTable.id)
        .references(() => accountTable.id),
});

export const knowledgeTable = pgTable("knowledge", {
    id: uuid("id").primaryKey().notNull(),
    agentId: uuid("agentId").references(() => accountTable.id),
    content: jsonb("content").default(""),
    embedding: vector("embedding", {
        dimensions: DIMENSIONS,
    }),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    isMain: boolean("isMain").default(false),
    originalId: uuid("originalId"),
    chunkIndex: integer("chunkIndex"),
    isShared: boolean("isShared").default(false),
});

export const cacheTable = pgTable("cache", {
    key: text("key").notNull(),
    agentId: text("agentId").notNull(),
    value: stringJsonb("value").default(""),
    createdAt: numberTimestamp("createdAt")
        .default(sql`now()`)
        .notNull(),
    expiresAt: numberTimestamp("expiresAt"),
});

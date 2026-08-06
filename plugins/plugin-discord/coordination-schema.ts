/**
 * Durable Discord group-room coordination tables. These tables intentionally
 * live in `public` with explicit `server_id` columns so plugin-sql's production
 * Row Level Security pass applies the same tenant policy used by core message
 * server tables.
 */
import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

export const discordCoordinationTrustMembersTable = pgTable(
	"discord_coordination_trust_members",
	{
		serverId: uuid("server_id").notNull(),
		accountId: text("account_id").notNull(),
		trustGroupId: text("trust_group_id").notNull(),
		runtimeInstanceId: text("runtime_instance_id").notNull(),
		agentId: uuid("agent_id").notNull(),
		allowed: boolean("allowed").default(true).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.default(sql`now()`)
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.serverId,
				table.accountId,
				table.trustGroupId,
				table.agentId,
			],
		}),
		index("discord_coord_trust_server_idx").on(table.serverId),
	],
);

export const discordCoordinationHumanEdgesTable = pgTable(
	"discord_coordination_human_edges",
	{
		serverId: uuid("server_id").notNull(),
		trustGroupId: text("trust_group_id").notNull(),
		channelId: text("channel_id").notNull(),
		edgeMessageId: text("edge_message_id").notNull(),
		edgeEpoch: text("edge_epoch").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.default(sql`now()`)
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.serverId, table.trustGroupId, table.channelId],
		}),
		unique("discord_coord_human_edge_epoch_unique").on(
			table.serverId,
			table.trustGroupId,
			table.channelId,
			table.edgeEpoch,
		),
	],
);

export const discordCoordinationReplySlotsTable = pgTable(
	"discord_coordination_reply_slots",
	{
		serverId: uuid("server_id").notNull(),
		trustGroupId: text("trust_group_id").notNull(),
		accountId: text("account_id").notNull(),
		channelId: text("channel_id").notNull(),
		edgeEpoch: text("edge_epoch").notNull(),
		// Reply lanes are budgeted independently: answering the human who set the
		// edge must not consume the bot-to-bot reply budget for that same edge (and
		// vice versa). Without this column both lanes contend for slot_index 0 and
		// the first human answer exhausts the bot budget for the whole edge.
		lane: text("lane").default("human").notNull(),
		slotIndex: integer("slot_index").notNull(),
		contenderToken: text("contender_token").notNull(),
		inboundMessageId: text("inbound_message_id").notNull(),
		nonce: text("nonce").notNull(),
		state: text("state").default("claimed").notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true })
			.default(sql`now()`)
			.notNull(),
		heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
			.default(sql`now()`)
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		deliveredMessageId: text("delivered_message_id"),
		// Bounds crash-sweeper re-dispatch: a poison inbound that kills every
		// holder is retired after MAX_SWEEP_RECOVERY_ATTEMPTS instead of looping.
		recoveryAttempts: integer("recovery_attempts").default(0).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.default(sql`now()`)
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.serverId,
				table.trustGroupId,
				table.channelId,
				table.edgeEpoch,
				table.lane,
				table.slotIndex,
			],
		}),
		// One inbound bot message may spend at most one budget slot. Without this
		// partial unique index, two contenders can win slot 0 and slot 1 for the
		// SAME bot message when budget > 1 and both send.
		uniqueIndex("discord_coord_reply_slots_bot_inbound_uq")
			.on(
				table.serverId,
				table.trustGroupId,
				table.channelId,
				table.edgeEpoch,
				table.lane,
				table.inboundMessageId,
			)
			.where(sql`${table.lane} = 'bot'`),
		index("discord_coord_reply_slots_nonce_idx").on(table.nonce),
		index("discord_coord_reply_slots_expiry_idx").on(table.expiresAt),
	],
);

export const discordCoordinationReceiptsTable = pgTable(
	"discord_coordination_receipts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		serverId: uuid("server_id").notNull(),
		accountId: text("account_id").notNull(),
		trustGroupId: text("trust_group_id").notNull(),
		channelId: text("channel_id").notNull(),
		edgeMessageId: text("edge_message_id").notNull(),
		edgeEpoch: text("edge_epoch"),
		kind: text("kind").notNull(),
		outcome: text("outcome"),
		contenderToken: text("contender_token"),
		holderToken: text("holder_token"),
		detail: text("detail"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`now()`)
			.notNull(),
	},
	(table) => [
		index("discord_coord_receipts_server_idx").on(table.serverId),
		index("discord_coord_receipts_channel_idx").on(
			table.serverId,
			table.accountId,
			table.channelId,
		),
	],
);

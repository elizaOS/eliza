/**
 * Unit tests for the canonical `channelParticipantSchema` table definition —
 * the pure data contract for the channel_participants join table that
 * `buildBaseTables` assembles and adapters materialize. Deterministic unit
 * harness over the real exported `SchemaTable`; no database or mocks.
 */
import { describe, expect, it } from "vitest";
import { channelParticipantSchema } from "./channel-participant";

describe("channelParticipantSchema", () => {
	it("declares the channel_participants join table in the default schema", () => {
		expect(channelParticipantSchema.name).toBe("channel_participants");
		expect(channelParticipantSchema.schema).toBe("");
	});

	it("requires both participant columns as non-null text", () => {
		const columns = channelParticipantSchema.columns;
		expect(Object.keys(columns)).toEqual(["channel_id", "entity_id"]);
		for (const key of ["channel_id", "entity_id"] as const) {
			expect(columns[key].name).toBe(key);
			expect(columns[key].type).toBe("text");
			expect(columns[key].notNull).toBe(true);
			// Primary-key semantics belong to the composite key below; no
			// column-level flag may duplicate them.
			expect(columns[key].primaryKey).toBeUndefined();
			expect(columns[key].isUnique).toBeUndefined();
		}
	});

	it("expresses exactly one composite primary key over (channel_id, entity_id)", () => {
		const pks = channelParticipantSchema.compositePrimaryKeys;
		expect(Object.keys(pks)).toEqual(["channel_participants_pk"]);
		expect(pks.channel_participants_pk.name).toBe("channel_participants_pk");
		expect(pks.channel_participants_pk.columns).toEqual([
			"channel_id",
			"entity_id",
		]);
	});

	it("indexes entity_id alone for reverse entity-to-channels lookups", () => {
		const indexes = channelParticipantSchema.indexes;
		expect(Object.keys(indexes)).toEqual(["idx_cp_entity"]);
		expect(indexes.idx_cp_entity.isUnique).toBe(false);
		expect(indexes.idx_cp_entity.columns).toEqual([
			{ expression: "entity_id", isExpression: false },
		]);
	});

	it("cascades channel deletion through a single FK to channels.id", () => {
		const fks = channelParticipantSchema.foreignKeys;
		expect(Object.keys(fks)).toEqual(["fk_channel_participant_channel"]);
		const fk = fks.fk_channel_participant_channel;
		expect(fk.tableFrom).toBe("channel_participants");
		expect(fk.tableTo).toBe("channels");
		expect(fk.columnsFrom).toEqual(["channel_id"]);
		expect(fk.columnsTo).toEqual(["id"]);
		expect(fk.onDelete).toBe("cascade");
		expect(fk.schemaTo).toBe("");
	});

	it("declares no unique or check constraints beyond the composite PK", () => {
		expect(channelParticipantSchema.uniqueConstraints).toEqual({});
		expect(channelParticipantSchema.checkConstraints).toEqual({});
	});
});

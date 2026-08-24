/**
 * Verifies the participants table descriptor keeps its one-membership-per-room
 * unique index, per-foreign-key lookup indexes, cascade delete bindings, and
 * the nullable membership columns the sql/localdb adapters materialize.
 */

import { describe, expect, it } from "vitest";
import { participantSchema } from "./participant";

describe("participants table schema", () => {
	it("declares the portable participants table", () => {
		expect(participantSchema.name).toBe("participants");
		expect(participantSchema.schema).toBe("");
	});

	it("makes id the sole primary key column with a database-side uuid default", () => {
		const primaryColumns = Object.entries(participantSchema.columns)
			.filter(([, column]) => column.primaryKey)
			.map(([key]) => key);
		expect(primaryColumns).toEqual(["id"]);
		expect(participantSchema.columns.id).toMatchObject({
			type: "uuid",
			notNull: true,
			default: "gen_random_uuid()",
		});
	});

	it("keeps every membership reference nullable and non-primary", () => {
		for (const key of ["entity_id", "room_id", "agent_id"]) {
			const column = participantSchema.columns[key];
			expect(column?.type).toBe("uuid");
			expect(column?.primaryKey).toBeUndefined();
			expect(column?.notNull).toBeUndefined();
		}
	});

	it("defaults created_at to now() and types room_state as free text", () => {
		expect(participantSchema.columns.created_at).toMatchObject({
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
		expect(participantSchema.columns.room_state).toMatchObject({
			type: "text",
		});
		expect(participantSchema.columns.room_state?.notNull).toBeUndefined();
	});

	it("defines exactly the six documented columns in declaration order", () => {
		expect(Object.keys(participantSchema.columns)).toEqual([
			"id",
			"created_at",
			"entity_id",
			"room_id",
			"agent_id",
			"room_state",
		]);
	});

	it("indexes each foreign-key column alone for its lookup scans", () => {
		expect(Object.keys(participantSchema.indexes)).toEqual([
			"idx_participants_user",
			"idx_participants_room",
			"idx_participants_entity_room",
			"idx_participants_agent",
		]);
		expect(participantSchema.indexes.idx_participants_user).toMatchObject({
			isUnique: false,
			columns: [{ expression: "entity_id", isExpression: false }],
		});
		expect(participantSchema.indexes.idx_participants_room).toMatchObject({
			isUnique: false,
			columns: [{ expression: "room_id", isExpression: false }],
		});
		expect(participantSchema.indexes.idx_participants_agent).toMatchObject({
			isUnique: false,
			columns: [{ expression: "agent_id", isExpression: false }],
		});
	});

	it("enforces one-membership-per-room through a unique (entity_id, room_id) index", () => {
		const index = participantSchema.indexes.idx_participants_entity_room;
		expect(index?.isUnique).toBe(true);
		expect(index?.name).toBe("idx_participants_entity_room");
		expect(index?.columns).toEqual([
			{ expression: "entity_id", isExpression: false },
			{ expression: "room_id", isExpression: false },
		]);
	});

	it("cascades room deletion down to participant rows", () => {
		const foreignKey = participantSchema.foreignKeys.fk_room;
		expect(foreignKey?.tableFrom).toBe("participants");
		expect(foreignKey?.tableTo).toBe("rooms");
		expect(foreignKey?.columnsFrom).toEqual(["room_id"]);
		expect(foreignKey?.columnsTo).toEqual(["id"]);
		expect(foreignKey?.onDelete).toBe("cascade");
		expect(foreignKey?.schemaTo).toBe("");
	});

	it("cascades entity deletion down to participant rows through fk_user", () => {
		const foreignKey = participantSchema.foreignKeys.fk_user;
		expect(foreignKey?.tableFrom).toBe("participants");
		expect(foreignKey?.tableTo).toBe("entities");
		expect(foreignKey?.columnsFrom).toEqual(["entity_id"]);
		expect(foreignKey?.columnsTo).toEqual(["id"]);
		expect(foreignKey?.onDelete).toBe("cascade");
		expect(foreignKey?.schemaTo).toBe("");
	});

	it("defines no additional foreign keys beyond the two documented joins", () => {
		expect(Object.keys(participantSchema.foreignKeys)).toEqual([
			"fk_room",
			"fk_user",
		]);
	});

	it("mirrors every declared column name on its own descriptor", () => {
		for (const [key, column] of Object.entries(participantSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("carries no competing key or check machinery", () => {
		expect(participantSchema.compositePrimaryKeys).toEqual({});
		expect(participantSchema.uniqueConstraints).toEqual({});
		expect(participantSchema.checkConstraints).toEqual({});
	});
});

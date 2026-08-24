/**
 * Tests for embedding schema — verifies the vector-store table descriptor.
 */
import { describe, expect, it } from "vitest";
import { embeddingSchema } from "./embedding.ts";

describe("embedding schema", () => {
	it("exports embeddingSchema with correct table name", () => {
		expect(embeddingSchema.name).toBe("embeddings");
	});

	it("has expected columns", () => {
		expect(embeddingSchema.columns.id.name).toBe("id");
		expect(embeddingSchema.columns.memory_id.name).toBe("memory_id");
		expect(embeddingSchema.columns.created_at.name).toBe("created_at");
		expect(embeddingSchema.columns.dim_384.name).toBe("dim_384");
		expect(embeddingSchema.columns.dim_3072.name).toBe("dim_3072");
	});

	it("has primary key on id", () => {
		expect(embeddingSchema.columns.id.primaryKey).toBe(true);
	});

	it("has foreign key to memories", () => {
		expect(embeddingSchema.foreignKeys.fk_embedding_memory).toBeDefined();
		expect(embeddingSchema.foreignKeys.fk_embedding_memory.tableTo).toBe(
			"memories",
		);
		expect(embeddingSchema.foreignKeys.fk_embedding_memory.onDelete).toBe(
			"cascade",
		);
	});

	it("has unique constraint on memory_id", () => {
		expect(
			embeddingSchema.uniqueConstraints.unique_embedding_memory,
		).toBeDefined();
		expect(
			embeddingSchema.uniqueConstraints.unique_embedding_memory.columns,
		).toEqual(["memory_id"]);
	});

	it("has index on memory_id", () => {
		expect(embeddingSchema.indexes.idx_embedding_memory).toBeDefined();
	});

	it("has check constraint on memory_id", () => {
		expect(
			embeddingSchema.checkConstraints.embedding_source_check,
		).toBeDefined();
	});
});

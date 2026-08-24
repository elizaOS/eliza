/**
 * Tests for cache schema — verifies the cache table descriptor.
 */
import { describe, expect, it } from "vitest";
import { cacheSchema } from "./cache.ts";

describe("cache schema", () => {
	it("exports cacheSchema with correct table name", () => {
		expect(cacheSchema.name).toBe("cache");
	});

	it("has expected columns", () => {
		expect(cacheSchema.columns.key.name).toBe("key");
		expect(cacheSchema.columns.agent_id.name).toBe("agent_id");
		expect(cacheSchema.columns.value.name).toBe("value");
		expect(cacheSchema.columns.created_at.name).toBe("created_at");
		expect(cacheSchema.columns.expires_at.name).toBe("expires_at");
	});

	it("has composite primary key on key and agent_id", () => {
		expect(cacheSchema.compositePrimaryKeys.cache_pk).toBeDefined();
		expect(cacheSchema.compositePrimaryKeys.cache_pk.columns).toEqual([
			"key",
			"agent_id",
		]);
	});

	it("has foreign key to agents", () => {
		expect(cacheSchema.foreignKeys.fk_cache_agent).toBeDefined();
		expect(cacheSchema.foreignKeys.fk_cache_agent.tableTo).toBe("agents");
		expect(cacheSchema.foreignKeys.fk_cache_agent.onDelete).toBe("cascade");
	});

	it("has no indexes or unique constraints", () => {
		expect(cacheSchema.indexes).toEqual({});
		expect(cacheSchema.uniqueConstraints).toEqual({});
	});
});

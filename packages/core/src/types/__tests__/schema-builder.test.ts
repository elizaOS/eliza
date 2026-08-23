import { describe, expect, it } from "vitest";
import { snakeToCamel } from "./schema-builder.ts";

describe("snakeToCamel", () => {
	it("converts snake_case to camelCase", () => {
		expect(snakeToCamel("agent_id")).toBe("agentId");
		expect(snakeToCamel("created_at")).toBe("createdAt");
		expect(snakeToCamel("user_profile_name")).toBe("userProfileName");
	});

	it("removes underscores before numbers", () => {
		expect(snakeToCamel("dim_384")).toBe("dim384");
		expect(snakeToCamel("vector_768")).toBe("vector768");
	});

	it("leaves already-camel and plain strings unchanged", () => {
		expect(snakeToCamel("agentId")).toBe("agentId");
		expect(snakeToCamel("name")).toBe("name");
	});

	it("handles leading and consecutive underscores", () => {
		expect(snakeToCamel("_private")).toBe("Private");
		expect(snakeToCamel("a__b")).toBe("aB");
	});
});

import { describe, expect, it } from "vitest";
import { snakeToCamel } from "../schema-builder.ts";

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

	it("handles leading underscores", () => {
		expect(snakeToCamel("_private")).toBe("Private");
		// 连续下划线：只有 _ 后跟字母/数字的会被转换
		expect(snakeToCamel("a__b")).toBe("a_B");
	});

	it("leaves trailing underscores in place", () => {
		expect(snakeToCamel("agent_")).toBe("agent_");
		expect(snakeToCamel("_")).toBe("_");
	});

	it("returns an empty string unchanged", () => {
		expect(snakeToCamel("")).toBe("");
	});

	it("preserves uppercase segments the regex does not match", () => {
		expect(snakeToCamel("table_NAME")).toBe("table_NAME");
		expect(snakeToCamel("Agent_ID")).toBe("Agent_ID");
	});

	it("converts a leading underscore followed by digits", () => {
		expect(snakeToCamel("_384")).toBe("384");
	});

	it("collapses multi-segment names mixing words and numbers", () => {
		expect(snakeToCamel("sha_256_hash")).toBe("sha256Hash");
		expect(snakeToCamel("content_vec_1536")).toBe("contentVec1536");
		expect(snakeToCamel("message_id_v2")).toBe("messageIdV2");
	});

	it("keeps digits without an underscore prefix unchanged", () => {
		expect(snakeToCamel("v2")).toBe("v2");
	});

	it("keeps one underscore when doubled before a digit", () => {
		expect(snakeToCamel("a__1")).toBe("a_1");
	});

	it("is idempotent on already-converted names", () => {
		const once = snakeToCamel("user_profile_name");
		expect(snakeToCamel(once)).toBe(once);
	});
});

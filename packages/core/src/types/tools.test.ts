import { describe, expect, it } from "vitest";
import {
	expandToolGroups,
	getToolGroupDefinition,
	getToolGroupRiskTags,
	TOOL_GROUP_DEFINITIONS,
	TOOL_GROUPS,
} from "./tools";

describe("TOOL_GROUPS", () => {
	it("keeps the legacy group-to-tools map compatible with expansion", () => {
		expect(TOOL_GROUPS["group:runtime"]).toEqual(["exec", "process"]);
		expect(expandToolGroups(["group:runtime", "read"])).toEqual([
			"exec",
			"process",
			"read",
		]);
	});

	it("requires explicit risk tags for every core tool group", () => {
		for (const [groupName, definition] of Object.entries(
			TOOL_GROUP_DEFINITIONS,
		)) {
			expect(definition.tools.length, groupName).toBeGreaterThan(0);
			expect(definition.riskTags.length, groupName).toBeGreaterThan(0);
			expect(definition.description.trim(), groupName).not.toBe("");
		}
	});

	it("exposes normalized group metadata for policy/audit callers", () => {
		expect(getToolGroupDefinition(" GROUP:RUNTIME ")?.riskTags).toContain(
			"host_execution",
		);
		expect(getToolGroupRiskTags("group:fs")).toEqual([
			"read_only",
			"workspace_write",
		]);
		expect(getToolGroupRiskTags("group:missing")).toEqual([]);
	});
});

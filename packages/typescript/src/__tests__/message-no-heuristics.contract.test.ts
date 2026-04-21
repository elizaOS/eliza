import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MESSAGE_SOURCE = path.resolve(
	import.meta.dirname,
	"../services/message.ts",
);

describe("message service no-heuristics contracts", () => {
	it("does not keep regex planner-repair tables in the response path", async () => {
		const source = await readFile(MESSAGE_SOURCE, "utf8");
		expect(source).not.toContain("PLANNER_ACTION_REPAIR_RULES");
		expect(source).not.toContain("inferPlannerActionRepairCandidates");
		expect(source).toContain("normalizePlannerProviders");
		expect(source).toContain("shouldRunProviderFollowup");
	});
});

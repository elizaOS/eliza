/**
 * Pins `AgentStatus`, the only runtime export of the core agent record
 * types. Its string values are persisted vocabulary: plugin-sql seeds store
 * them in SQL agent rows and openclaw archive migration writes "active"
 * literally, so a rename here silently desynchronizes stored records across
 * modules. The module's other exports are compile-time interfaces with no
 * runtime surface to exercise.
 */
import { describe, expect, it } from "vitest";
import { AgentStatus } from "./agent.js";

describe("AgentStatus", () => {
	it("exposes the persisted status literals", () => {
		expect(AgentStatus.ACTIVE).toBe("active");
		expect(AgentStatus.INACTIVE).toBe("inactive");
	});

	it("serializes through JSON without numeric coercion", () => {
		for (const status of [AgentStatus.ACTIVE, AgentStatus.INACTIVE]) {
			const roundTripped = JSON.parse(JSON.stringify({ status })) as {
				status: string;
			};
			expect(roundTripped.status).toBe(status);
			expect(typeof roundTripped.status).toBe("string");
		}
	});

	it("exposes exactly two members with no reverse mapping", () => {
		expect(Object.keys(AgentStatus).sort()).toEqual(["ACTIVE", "INACTIVE"]);
		expect([...Object.values(AgentStatus)].sort()).toEqual([
			"active",
			"inactive",
		]);
	});

	it("distinguishes active from inactive", () => {
		expect(AgentStatus.ACTIVE).not.toBe(AgentStatus.INACTIVE);
	});
});

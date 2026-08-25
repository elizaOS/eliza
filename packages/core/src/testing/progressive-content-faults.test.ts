/** Proves the fault registry executes its exact catalog and fails closed on missing lanes. */

import { describe, expect, it } from "vitest";
import {
	PROGRESSIVE_CONTENT_FAULT_CASES,
	runProgressiveContentFaultRegistry,
} from "./progressive-content-faults";

describe("progressive content fault registry", () => {
	it("retains missing injectors as failed rows", async () => {
		const report = await runProgressiveContentFaultRegistry({ executors: {} });
		expect(report).toMatchObject({
			status: "failed",
			required: PROGRESSIVE_CONTENT_FAULT_CASES.length,
			executed: 0,
		});
		expect(report.results.every(({ status }) => status === "failed")).toBe(
			true,
		);
	});

	it("passes only when every injector returns its typed code without effects", async () => {
		const executors = Object.fromEntries(
			PROGRESSIVE_CONTENT_FAULT_CASES.map(([id, , expectedCode]) => [
				id,
				() => ({ code: expectedCode, effects: [] }),
			]),
		);
		const report = await runProgressiveContentFaultRegistry({ executors });
		expect(report).toMatchObject({
			status: "passed",
			required: PROGRESSIVE_CONTENT_FAULT_CASES.length,
			executed: PROGRESSIVE_CONTENT_FAULT_CASES.length,
		});
	});

	it("fails a typed code that carries a forbidden side effect", async () => {
		const executors = Object.fromEntries(
			PROGRESSIVE_CONTENT_FAULT_CASES.map(([id, , expectedCode]) => [
				id,
				() => ({ code: expectedCode, effects: [] }),
			]),
		);
		executors.unauthorized = () => ({
			code: "CONTENT_ACCESS_DENIED",
			effects: ["unauthorized-bytes"],
		});
		const report = await runProgressiveContentFaultRegistry({ executors });
		expect(report.status).toBe("failed");
		expect(report.results[0]).toMatchObject({
			id: "unauthorized",
			status: "failed",
			observedEffects: ["unauthorized-bytes"],
		});
	});
});

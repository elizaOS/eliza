/** Exercises the global trajectory JSON budget against adversarial shared graphs. */

import { describe, expect, it } from "vitest";
import { sanitizeTrajectoryJsonObject } from "./trajectory-json";

describe("trajectory JSON normalization", () => {
	it("bounds shared-DAG expansion by nodes and serialized bytes", () => {
		let shared: Record<string, unknown> = { leaf: "value" };
		for (let depth = 0; depth < 30; depth += 1) {
			shared = { left: shared, right: shared };
		}

		const startedAt = performance.now();
		const sanitized = sanitizeTrajectoryJsonObject({ shared });
		const elapsedMs = performance.now() - startedAt;
		const serialized = JSON.stringify(sanitized);

		expect(elapsedMs).toBeLessThan(1_000);
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
			1024 * 1024,
		);
		expect(serialized).toContain('"reason":"global_budget"');
	});
});

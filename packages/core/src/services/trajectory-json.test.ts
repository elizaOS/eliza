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

	it("preserves UTF-16 surrogate pairs when truncating large strings", () => {
		// "🔥" is 2 code units. 40,000 repeats = 80,000 units > 64 * 1024 (65536)
		// TRAJECTORY_JSON_MAX_STRING_CHARS = 65536
		// TRAJECTORY_JSON_TRUNCATION_SUFFIX = "...[truncated]" (15 chars)
		// previewLength = 65536 - 15 = 65521 (odd). Slicing at 65521 bisects a surrogate pair.
		const longEmoji = "🔥".repeat(40_000);
		const sanitized = sanitizeTrajectoryJsonObject({ text: longEmoji });
		expect(sanitized).toBeDefined();
		const result = sanitized!.text as string;
		expect(result.endsWith("...[truncated]")).toBe(true);
		for (const char of result) {
			expect(
				/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
					char,
				),
			).toBe(false);
		}
	});
});

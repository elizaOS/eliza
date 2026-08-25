/** Verifies repeated-failure signatures normalize malformed Unicode without losing error detail. */

import { describe, expect, it } from "vitest";

import { toWellFormedUnicode } from "../utils/well-formed";
import { getFailureSignature } from "./limits";

describe("getFailureSignature", () => {
	it("normalizes malformed Unicode and preserves the complete provider error", () => {
		const tail = `${"x".repeat(500)}tail`;
		const signature = getFailureSignature({
			success: false,
			toolName: "WEB_FETCH",
			error: `upstream said \uD800 and continued ${tail}`,
		});

		expect(signature).not.toBeNull();
		expect(signature as string).toBe(toWellFormedUnicode(signature as string));
		expect((signature as string).includes("\uD800")).toBe(false);
		expect(signature).toContain(tail);
		expect(signature).toContain("tail");
	});
});

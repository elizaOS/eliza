import { describe, expect, it } from "vitest";
import { isTransientModelError } from "../src/utils/model-errors.ts";

describe("isTransientModelError status codes", () => {
	it("still treats a bare 503 as transient", () => {
		expect(isTransientModelError(new Error("HTTP 503 Service Unavailable"))).toBe(
			true,
		);
		expect(isTransientModelError(new Error("503"))).toBe(true);
	});

	it("does not treat 1503 or 5030 as a 503", () => {
		expect(isTransientModelError(new Error("job 1503 failed"))).toBe(false);
		expect(isTransientModelError(new Error("error 5030"))).toBe(false);
		expect(isTransientModelError(new Error("request 15029 timed out"))).toBe(
			true,
		);
	});

	it("still treats prose rate-limit and timeout signals as transient", () => {
		expect(isTransientModelError(new Error("rate limit exceeded"))).toBe(true);
		expect(isTransientModelError(new Error("request timed out"))).toBe(true);
	});
});

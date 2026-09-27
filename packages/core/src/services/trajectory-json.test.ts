import { describe, expect, it } from "vitest";
import { sanitizeTrajectoryJsonValue } from "./trajectory-json";

describe("sanitizeTrajectoryJsonValue own __proto__ entries", () => {
	it.each([
		["a parsed object", JSON.parse('{"a":1,"__proto__":{"polluted":true}}')],
		[
			"a Map",
			new Map<string, unknown>([
				["a", 1],
				["__proto__", { polluted: true }],
			]),
		],
	])("keeps the entry as data for %s", (_label, input) => {
		const sanitized = sanitizeTrajectoryJsonValue(input) as Record<
			string,
			unknown
		>;
		expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
		expect(Object.hasOwn(sanitized, "__proto__")).toBe(true);
		expect((sanitized as { polluted?: unknown }).polluted).toBeUndefined();
		expect(JSON.stringify(sanitized)).toBe(
			'{"a":1,"__proto__":{"polluted":true}}',
		);
	});
});

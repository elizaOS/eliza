/** Exercises lossless trajectory JSON normalization for large prompt evidence. */

import { describe, expect, it } from "vitest";
import {
	sanitizeTrajectoryJsonObject,
	sanitizeTrajectoryJsonValue,
} from "./trajectory-json";

describe("trajectory JSON normalization", () => {
	it("preserves strings and collections beyond the former capture limits", () => {
		const prompt = `${"p".repeat(1_100_000)}🦊tail`;
		const messages = Array.from(
			{ length: 300 },
			(_, index) => `message-${index}`,
		);
		const sanitized = sanitizeTrajectoryJsonObject({ prompt, messages });
		expect(sanitized?.prompt).toBe(prompt);
		expect(sanitized?.messages).toEqual(messages);
	});
});

describe("trajectory JSON own-key preservation", () => {
	// `JSON.parse` creates `__proto__` as an own data property. Rebuilding the
	// record with `output[key] = …` invokes the prototype setter instead, which
	// both drops the argument from the persisted trajectory and re-parents the
	// sanitized object to caller-controlled data.
	const rawToolCall = String.raw`{"path":"/etc/passwd","__proto__":{"approved":true}}`;

	it("keeps an own __proto__ key instead of dropping it", () => {
		const sanitized = sanitizeTrajectoryJsonValue(JSON.parse(rawToolCall)) as
			| Record<string, unknown>
			| undefined;

		expect(Object.keys(sanitized ?? {})).toEqual(["path", "__proto__"]);
		expect(JSON.stringify(sanitized)).toBe(rawToolCall);
	});

	it("does not re-parent the sanitized object to caller data", () => {
		const sanitized = sanitizeTrajectoryJsonValue(JSON.parse(rawToolCall)) as
			| Record<string, unknown>
			| undefined;

		expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
		expect((sanitized as { approved?: unknown }).approved).toBeUndefined();
		expect(({} as { approved?: unknown }).approved).toBeUndefined();
	});

	it("preserves an own __proto__ key nested inside a recorded object", () => {
		const sanitized = sanitizeTrajectoryJsonObject(
			JSON.parse(String.raw`{"action":{"__proto__":{"approved":true}}}`),
		);

		expect(JSON.stringify(sanitized)).toBe(
			String.raw`{"action":{"__proto__":{"approved":true}}}`,
		);
	});

	it("still normalizes ordinary records unchanged", () => {
		const sanitized = sanitizeTrajectoryJsonObject({ a: 1, b: ["x"] });

		expect(sanitized).toEqual({ a: 1, b: ["x"] });
		expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
	});

	it("keeps an own __proto__ entry recorded through a Map", () => {
		const sanitized = sanitizeTrajectoryJsonValue(
			new Map<string, unknown>([
				["path", "/etc/passwd"],
				["__proto__", { approved: true }],
			]),
		) as Record<string, unknown> | undefined;

		expect(Object.keys(sanitized ?? {})).toEqual(["path", "__proto__"]);
		expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
		expect((sanitized as { approved?: unknown }).approved).toBeUndefined();
	});
});

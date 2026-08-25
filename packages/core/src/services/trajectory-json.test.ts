/** Exercises lossless trajectory JSON normalization for large prompt evidence. */

import { describe, expect, it } from "vitest";
import { sanitizeTrajectoryJsonObject } from "./trajectory-json";

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

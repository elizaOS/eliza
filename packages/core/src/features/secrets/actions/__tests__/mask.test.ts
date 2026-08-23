import { describe, expect, it } from "vitest";
import { maskSecretValue } from "./mask.ts";

describe("maskSecretValue", () => {
	it("masks short values entirely", () => {
		expect(maskSecretValue("12345678")).toBe("****");
		expect(maskSecretValue("")).toBe("****");
	});

	it("keeps the first and last 4 chars", () => {
		expect(maskSecretValue("abcdefghijklmnop")).toBe("abcd********mnop");
	});

	it("caps the mask at 20 stars", () => {
		const long = "a".repeat(4) + "x".repeat(100) + "b".repeat(4);
		const out = maskSecretValue(long);
		expect(out.startsWith("aaaa")).toBe(true);
		expect(out.endsWith("bbbb")).toBe(true);
		expect(out.length).toBe(4 + 20 + 4);
	});
});

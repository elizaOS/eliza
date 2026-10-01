import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("voice-gate source", () => {
	it("contains no literal NUL bytes, so git and rg treat it as text", () => {
		const bytes = readFileSync(new URL("./voice-gate.ts", import.meta.url));
		expect(bytes.includes(0)).toBe(false);
	});
});

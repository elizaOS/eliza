import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-pdf", () => {
	it("exports the plugin", async () => {
		const mod = await import("../index.ts");
		expect(mod).toBeDefined();
	});
});
